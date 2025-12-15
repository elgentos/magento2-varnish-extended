<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\PurgeStatistics;

use Elgentos\VarnishExtended\Model\NotificationInterface;
use Magento\Framework\FlagManager;

class Notification implements NotificationInterface
{

    public const VARNISH_PURGE_STATS = 'varnish-purge-stats';

    public function __construct(
        private readonly FlagManager $flagManager,
    ) {}

    public function getIdentity()
    {
    }

    public function isDisplayed(): bool
    {
        $stats = $this->flagManager->getFlagData(self::VARNISH_PURGE_STATS);
        return $stats !== null && is_array($stats);
    }

    public function getText(): string
    {
        $stats = $this->flagManager->getFlagData(self::VARNISH_PURGE_STATS);
        
        if (!is_array($stats)) {
            return '';
        }

        $objectsPurged = $stats['objects_purged'] ?? 0;
        $timestamp = $stats['timestamp'] ?? null;
        
        $message = '<p>';
        $message .= __('Last cache purge: <strong>%1 object(s)</strong> were purged from Varnish.', $objectsPurged);
        
        if ($timestamp) {
            $date = date('Y-m-d H:i:s', $timestamp);
            $message .= ' ' . __('(Purged at: %1)', $date);
        }
        
        $message .= '</p>';

        return $message;
    }

    public function getSeverity()
    {
        return self::SEVERITY_NOTICE;
    }
}
