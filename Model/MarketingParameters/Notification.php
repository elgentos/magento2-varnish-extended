<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\MarketingParameters;

use Elgentos\VarnishExtended\Model\NotificationInterface;
use Magento\Framework\FlagManager;

class Notification implements NotificationInterface
{

    public const VARNISH_MARKETING_PARAMS = 'varnish-marketing-params';

    public function __construct(
        private readonly FlagManager $flagManager,
    ) {
    }

    public function getIdentity(): string
    {
        return self::VARNISH_MARKETING_PARAMS;
    }

    public function isDisplayed(): bool
    {
        return (bool)$this->flagManager->getFlagData(self::VARNISH_MARKETING_PARAMS);
    }

    public function getText(): string
    {
        return '<p>' . __(
            'We found marketing parameter(s) that will be stripped in Varnish, ' .
                'this can lead to filtering not working properly on category pages.'
            ) . '</p>';
    }

    public function getSeverity(): int
    {
        return self::SEVERITY_CRITICAL;
    }
}
