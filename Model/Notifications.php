<?php

namespace Elgentos\VarnishExtended\Model;

use Elgentos\VarnishExtended\Model\NotificationInterface;
use Magento\Backend\Controller\Adminhtml\System;
use Magento\Framework\AuthorizationInterface;
use Magento\Framework\Escaper;
use Magento\Framework\Notification\MessageInterface;
use Magento\Framework\UrlInterface;

class Notifications implements MessageInterface
{
    /**
     * @param AuthorizationInterface $authorization
     * @param UrlInterface $urlBuilder
     * @param Escaper $escaper
     * @param NotificationInterface[] $notifications
     */
    public function __construct(
        private readonly AuthorizationInterface $authorization,
        private readonly UrlInterface $urlBuilder,
        private readonly Escaper $escaper,
        private readonly array $notifications = [],
    ) {}

    public function getIdentity(): string
    {
        return 'VARNISH_VCL_NOTIFICATIONS';
    }

    public function isDisplayed(): bool
    {
        if (! $this->authorization->isAllowed(System::ADMIN_RESOURCE)) {
            return false;
        }

        foreach ($this->notifications as $notification) {
            if ($notification->isDisplayed()) {
                return true;
            }
        }

        return false;
    }

    public function getText(): string
    {
        $messageDetails = '';

        foreach ($this->notifications as $notification) {
            if ($notification->isDisplayed()) {
                $messageDetails .= $notification->getText();
            }
        }

        $messageDetails .= '<p>';
        $messageDetails .= __('Something is off in your Varnish configuration.');
        $messageDetails .= __(
            'Click here to go to <a href="%1">Varnish Configuration</a> and check your settings.',
            $this->getStoreConfigUrl()
        );
        $messageDetails .= '</p>';

        return $messageDetails;
    }

    public function getSeverity(): int
    {
        return static::SEVERITY_CRITICAL;
    }

    private function getStoreConfigUrl(): string
    {
        return $this->escaper->escapeUrl(
            $this->urlBuilder->getUrl('adminhtml/system_config/index', [
                'section' => 'system',
                '_fragment' => 'system_full_page_cache-link'
            ])
        );
    }
}
