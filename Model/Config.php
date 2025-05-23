<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model;

use Magento\Framework\App\Config\ScopeConfigInterface;

class Config
{
    public function __construct(private readonly ScopeConfigInterface $scopeConfig)
    {
    }

    public function getTrackingParameters(): string
    {
        return $this->scopeConfig->getValue('system/full_page_cache/varnish/tracking_parameters');
    }
}
