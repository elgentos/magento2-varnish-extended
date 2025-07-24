<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model;

use Magento\Framework\App\Cache\StateInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Filesystem\Directory\ReadFactory;
use Magento\Framework\HTTP\PhpEnvironment\Request;
use Magento\Framework\Module\Dir\Reader;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\PageCache\Model\Config as PageCacheConfig;
use Magento\PageCache\Model\Varnish\VclGeneratorFactory;
use Magento\Store\Model\ScopeInterface;

class Config extends PageCacheConfig
{
    private ScopeConfigInterface $scopeConfig;

    private Json $serializer;

    public const XML_PATH_VARNISH_ENABLE_BFCACHE = 'system/full_page_cache/varnish/enable_bfcache';

    public const XML_PATH_VARNISH_ENABLE_MEDIA_CACHE = 'system/full_page_cache/varnish/enable_media_cache';

    public const XML_PATH_VARNISH_ENABLE_STATIC_CACHE = 'system/full_page_cache/varnish/enable_static_cache';

    public const XML_PATH_VARNISH_TRACKING_PARAMETERS = 'system/full_page_cache/varnish/tracking_parameters';

    public const XML_PATH_VARNISH_USE_XKEY_VMOD = 'system/full_page_cache/varnish/use_xkey_vmod';

    public const XML_PATH_VARNISH_USE_SOFT_PURGING = 'system/full_page_cache/varnish/use_soft_purging';

    public const XML_PATH_VARNISH_PASS_ON_COOKIE_PRESENCE = 'system/full_page_cache/varnish/pass_on_cookie_presence';

    public const XML_PATH_VARNISH_BYPASS_ROUTES = 'system/full_page_cache/varnish/bypass_routes';

    public function __construct(
        ReadFactory $readFactory,
        ScopeConfigInterface $scopeConfig,
        StateInterface $cacheState,
        Reader $reader,
        VclGeneratorFactory $vclGeneratorFactory,
        Json $serializer
    ) {
        parent::__construct(
            $readFactory,
            $scopeConfig,
            $cacheState,
            $reader,
            $vclGeneratorFactory,
            $serializer
        );
        $this->serializer = $serializer;
        $this->scopeConfig = $scopeConfig;
    }

    public function getTrackingParameters(): string
    {
        $trackingParams = $this->scopeConfig->getValue(static::XML_PATH_VARNISH_TRACKING_PARAMETERS);

        if (is_string($trackingParams) && !json_decode($trackingParams)) { // fallback for version 1.0.0 notation
            return $trackingParams;
        }

        return implode('|', array_map(function ($param) {
            return $param['param'];
        }, is_array($trackingParams) ? $trackingParams : json_decode($trackingParams, true)));
    }

    public function getUseXkeyVmod(): bool
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_USE_XKEY_VMOD);
    }

    public function getUseSoftPurging(): bool
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_USE_SOFT_PURGING);
    }

    public function getPassOnCookiePresence(): array
    {
        return $this->serializer->unserialize($this->scopeConfig->getValue(static::XML_PATH_VARNISH_PASS_ON_COOKIE_PRESENCE) ?? '{}');
    }

    public function getEnableBfcache(): bool
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_ENABLE_BFCACHE);
    }

    public function getSslOffloadedHeader()
    {
        return $this->scopeConfig->getValue(Request::XML_PATH_OFFLOADER_HEADER);
    }

    public function getBackendHost()
    {
        return $this->scopeConfig->getValue(static::XML_VARNISH_PAGECACHE_BACKEND_HOST);
    }

    public function getBackendPort()
    {
        return $this->scopeConfig->getValue(static::XML_VARNISH_PAGECACHE_BACKEND_PORT);
    }

    public function getAccessList()
    {
        $accessList = $this->_scopeConfig->getValue(static::XML_VARNISH_PAGECACHE_ACCESS_LIST);
        return array_map('trim', explode(',', $accessList));
    }

    public function getGracePeriod()
    {
        return $this->scopeConfig->getValue(static::XML_VARNISH_PAGECACHE_GRACE_PERIOD);
    }

    public function getDesignExceptions()
    {
        $expressions = $this->scopeConfig->getValue(
            \Magento\PageCache\Model\Config::XML_VARNISH_PAGECACHE_DESIGN_THEME_REGEX,
            ScopeInterface::SCOPE_STORE
        );

        return $expressions ? $this->serializer->unserialize($expressions) : [];
    }

    public function getEnableMediaCache(): bool
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_ENABLE_MEDIA_CACHE);
    }

    public function getEnableStaticCache(): bool
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_ENABLE_STATIC_CACHE);
    }

    public function getBypassRoutes() : array
    {
        return (bool) $this->scopeConfig->getValue(static::XML_PATH_VARNISH_BYPASS_ROUTES);
    }
}
