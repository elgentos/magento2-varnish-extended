<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\HTTP\PhpEnvironment\Request;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\PageCache\Model\Config as PageCacheConfig;
use Magento\PageCache\Model\Varnish\VclGeneratorFactory;

class Config extends PageCacheConfig
{
    private ScopeConfigInterface $scopeConfig;

    public const string XML_PATH_VARNISH_ENABLE_BFCACHE = 'system/full_page_cache/varnish/enable_bfcache';

    public const string XML_PATH_VARNISH_TRACKING_PARAMETERS = 'system/full_page_cache/varnish/tracking_parameters';

    public function __construct(
        \Magento\Framework\Filesystem\Directory\ReadFactory $readFactory,
        \Magento\Framework\App\Config\ScopeConfigInterface $scopeConfig,
        \Magento\Framework\App\Cache\StateInterface $cacheState,
        \Magento\Framework\Module\Dir\Reader $reader,
        \Magento\PageCache\Model\Varnish\VclGeneratorFactory $vclGeneratorFactory,
        ?\Magento\Framework\Serialize\Serializer\Json $serializer = null
    ) {
        parent::__construct(
            $readFactory,
            $scopeConfig,
            $cacheState,
            $reader,
            $vclGeneratorFactory,
            $serializer
        );
        $this->scopeConfig = $scopeConfig;
    }

    public function getTrackingParameters(): string
    {
        return $this->scopeConfig->getValue(self::XML_PATH_VARNISH_TRACKING_PARAMETERS);
    }

    public function getEnableBfcache(): string
    {
        return $this->scopeConfig->getValue(self::XML_PATH_VARNISH_ENABLE_BFCACHE);
    }

    public function getSslOffloadedHeader()
    {
        return $this->scopeConfig->getValue(Request::XML_PATH_OFFLOADER_HEADER);
    }

    public function getBackendHost()
    {
        return $this->scopeConfig->getValue(self::XML_VARNISH_PAGECACHE_BACKEND_HOST);
    }

    public function getBackendPort()
    {
        return $this->scopeConfig->getValue(self::XML_VARNISH_PAGECACHE_BACKEND_PORT);
    }

    public function getAccessList()
    {
        $accessList = $this->_scopeConfig->getValue(self::XML_VARNISH_PAGECACHE_ACCESS_LIST);
        return array_map('trim', explode(',', $accessList));
    }

    public function getGracePeriod()
    {
        return $this->scopeConfig->getValue(self::XML_VARNISH_PAGECACHE_GRACE_PERIOD);
    }

    public function getDesignExceptions()
    {
        return $this->_getDesignExceptions();
    }
}
