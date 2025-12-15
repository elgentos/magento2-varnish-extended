<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model;

use Exception;
use Generator;
use Elgentos\VarnishExtended\Model\PurgeStatistics\Notification as PurgeStatsNotification;
use Magento\CacheInvalidate\Model\SocketFactory;
use Magento\Framework\Cache\InvalidateLogger;
use Magento\Framework\FlagManager;
use Magento\PageCache\Model\Cache\Server;
use Laminas\Http\Client\Adapter\Socket;
use Laminas\Uri\Uri;

/**
 * Invalidate external HTTP cache(s) based on tag pattern
 */
class PurgeCache extends \Magento\CacheInvalidate\Model\PurgeCache
{
    const string HEADER_X_MAGENTO_PURGE_SOFT = 'X-Magento-Purge-Soft';

    /**
     * @var Config
     */
    private $varnishExtendedConfig;
    /**
     * @var InvalidateLogger
     */
    private $logger;

    /**
     * @var FlagManager
     */
    private $flagManager;

    /**
     * Batch size of the purge request.
     *
     * Based on default Varnish 6 http_req_hdr_len size minus a 512 bytes margin for method,
     * header name, line feeds etc.
     *
     * @see https://varnish-cache.org/docs/6.0/reference/varnishd.html
     *
     * @var int
     */
    private $maxHeaderSize;

    public function __construct(
        Server $cacheServer,
        SocketFactory $socketAdapterFactory,
        InvalidateLogger $logger,
        Config $varnishExtendedConfig,
        FlagManager $flagManager,
        int $maxHeaderSize = 7680,
    ) {
        parent::__construct(
            $cacheServer,
            $socketAdapterFactory,
            $logger,
            $maxHeaderSize
        );
        $this->logger = $logger;
        $this->varnishExtendedConfig = $varnishExtendedConfig;
        $this->flagManager = $flagManager;
    }

    /**
     * Send curl purge request to invalidate cache by tags pattern
     *
     * @param array|string $tags
     * @return bool Return true if successful; otherwise return false
     */
    public function sendPurgeRequest($tags): bool
    {
        if (is_string($tags)) {
            $tags = [$tags];
        }

        $successful = true;
        $totalObjectsPurged = 0;
        $socketAdapter = $this->socketAdapterFactory->create();
        $servers = $this->cacheServer->getUris();
        $socketAdapter->setOptions(['timeout' => 10]);

        $formattedTagsChunks = $this->chunkTags($tags);
        foreach ($formattedTagsChunks as $formattedTagsChunk) {
            $result = $this->sendPurgeRequestToServers($socketAdapter, $servers, $formattedTagsChunk);
            if ($result === false) {
                $successful = false;
            } elseif (is_int($result)) {
                $totalObjectsPurged += $result;
            }
        }

        // Store purge statistics for admin notification
        $this->storePurgeStatistics($totalObjectsPurged);

        return $successful;
    }

    /**
     * Split tags into batches to suit Varnish max. header size
     *
     * @param array $tags
     * @return Generator
     */
    private function chunkTags(array $tags): Generator
    {
        $currentBatchSize = 0;
        $formattedTagsChunk = [];
        foreach ($tags as $formattedTag) {
            // Check if (currentBatchSize + length of next tag + number of pipe delimiters) would exceed header size.
            if ($currentBatchSize + strlen($formattedTag ?: '') + count($formattedTagsChunk) > $this->maxHeaderSize) {
                yield implode('|', $formattedTagsChunk);
                $formattedTagsChunk = [];
                $currentBatchSize = 0;
            }

            $currentBatchSize += strlen($formattedTag ?: '');
            $formattedTagsChunk[] = $formattedTag;
        }
        if (!empty($formattedTagsChunk)) {
            yield implode('|', $formattedTagsChunk);
        }
    }

    /**
     * Send curl purge request to servers to invalidate cache by tags pattern
     *
     * @param Socket $socketAdapter
     * @param Uri[] $servers
     * @param string $formattedTagsChunk
     * @return int|false Return number of purged objects on success, false on total failure
     */
    private function sendPurgeRequestToServers(Socket $socketAdapter, array $servers, string $formattedTagsChunk): bool|int
    {
        $headers = [self::HEADER_X_MAGENTO_TAGS_PATTERN => $formattedTagsChunk];
        if ($this->varnishExtendedConfig->getUseSoftPurging()) {
            $headers[self::HEADER_X_MAGENTO_PURGE_SOFT] = 1;
        }
        $unresponsiveServerError = [];
        $objectsPurged = 0;
        
        foreach ($servers as $server) {
            $headers['Host'] = $server->getHost();
            try {
                $socketAdapter->connect($server->getHost(), $server->getPort());
                $socketAdapter->write(
                    'PURGE',
                    $server,
                    '1.1',
                    $headers
                );
                $response = $socketAdapter->read();
                $socketAdapter->close();
                
                // Parse the response to extract the number of purged objects
                $purgedCount = $this->parseVarnishResponse($response);
                if ($purgedCount > 0) {
                    $objectsPurged += $purgedCount;
                }
            } catch (Exception $e) {
                $unresponsiveServerError[] = "Cache host: " . $server->getHost() . ":" . $server->getPort() .
                    "resulted in error message: " . $e->getMessage();
            }
        }

        $errorCount = count($unresponsiveServerError);

        if ($errorCount > 0) {
            $loggerMessage = implode(" ", $unresponsiveServerError);

            if ($errorCount == count($servers)) {
                $this->logger->critical(
                    'No cache server(s) could be purged ' . $loggerMessage,
                    compact('servers', 'formattedTagsChunk')
                );
                return false;
            }

            $this->logger->warning(
                'Unresponsive cache server(s) hit' . $loggerMessage,
                compact('servers', 'formattedTagsChunk')
            );
        }

        $this->logger->execute(compact('servers', 'formattedTagsChunk'));
        return $objectsPurged;
    }

    /**
     * Parse Varnish response to extract number of purged objects
     *
     * @param string $response
     * @return int
     */
    private function parseVarnishResponse(string $response): int
    {
        // Extract JSON body from HTTP response
        // Expected format: { "invalidated": <number> }
        // Split response into headers and body
        $parts = explode("\r\n\r\n", $response, 2);
        if (count($parts) < 2) {
            return 0;
        }
        
        $body = trim($parts[1]);
        $data = json_decode($body, true);
        
        if (json_last_error() === JSON_ERROR_NONE && isset($data['invalidated'])) {
            return (int)$data['invalidated'];
        }
        
        return 0;
    }

    /**
     * Store purge statistics for admin notification
     *
     * @param int $objectsPurged
     * @return void
     */
    private function storePurgeStatistics(int $objectsPurged): void
    {
        if ($objectsPurged > 0) {
            $this->flagManager->saveFlag(
                PurgeStatsNotification::VARNISH_PURGE_STATS,
                [
                    'objects_purged' => $objectsPurged,
                    'timestamp' => time()
                ]
            );
        }
    }
}
