<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\Varnish;

use Elgentos\VarnishExtended\Model\Config;
use Elgentos\VarnishExtended\Model\TemplateFactory;
use Magento\PageCache\Model\VclTemplateLocatorInterface;

class VCLGenerator extends \Magento\PageCache\Model\Varnish\VclGenerator
{
    public function __construct(
        private readonly TemplateFactory $templateFactory,
        private readonly VclTemplateLocatorInterface $vclTemplateLocator,
        private readonly string $backendHost,
        private readonly int $backendPort,
        private readonly array $accessList,
        private readonly int $gracePeriod,
        private readonly string $sslOffloadedHeader,
        private readonly Config $varnishExtendedConfig,
        private readonly array $designExceptions = [],
    ) {
        parent::__construct(
            $vclTemplateLocator,
            $backendHost,
            $backendPort,
            $accessList,
            $gracePeriod,
            $sslOffloadedHeader
        );
    }

    public function generateVcl($version, $inputFile = null)
    {
        $templateRenderer = $this->templateFactory->create($this->getVariables());
        $template = $this->vclTemplateLocator->getTemplate($version, $inputFile);
        return $templateRenderer->filter($template);
    }

    public function getVariables(): array
    {
        return [
            'host' => $this->backendHost,
            'port' => $this->backendPort,
            'access_list' => $this->getTransformedAccessList(),
            'grace_period' => $this->gracePeriod,
            'ssl_offloaded_header' => $this->sslOffloadedHeader,
            'tracking_parameters' => $this->varnishExtendedConfig->getTrackingParameters(),
            'enable_bfcache' => (bool) $this->varnishExtendedConfig->getEnableBfcache(),
            'disable_bfcache' => (bool) !$this->varnishExtendedConfig->getEnableBfcache(),
            'enable_media_cache' => (bool) $this->varnishExtendedConfig->getEnableMediaCache(),
            'enable_static_cache' => (bool) $this->varnishExtendedConfig->getEnableStaticCache(),
            'use_xkey_vmod' => (int) $this->varnishExtendedConfig->getUseXkeyVmod(),
            'use_soft_purging' => (int) $this->varnishExtendedConfig->getUseSoftPurging(),
            'pass_on_cookie_presence' => $this->varnishExtendedConfig->getPassOnCookiePresence(),
            'design_exceptions_code' => $this->getRegexForDesignExceptions(),
            'ip_forward_header' => $this->varnishExtendedConfig->getIpForwardHeader()
        ];
    }

    /**
     * Get regexs for design exceptions
     * Different browser user-agents may use different themes
     * Varnish supports regex with internal modifiers only so
     * we have to convert "/pattern/iU" into "(?Ui)pattern"
     *
     * @return string
     */
    private function getRegexForDesignExceptions(): string
    {
        $result = '';
        $tpl = "%s (req.http.user-agent ~ \"%s\") {\n" . "        hash_data(\"%s\");\n" . "    }";

        if (!$this->designExceptions) {
            return $result;
        }

        $rules = array_values($this->designExceptions);
        foreach ($rules as $i => $rule) {
            if (preg_match('/^[\W]{1}(.*)[\W]{1}(\w+)?$/', $rule['regexp'] ?? '', $matches)) {
                if (!empty($matches[2])) {
                    $pattern = sprintf("(?%s)%s", $matches[2], $matches[1]);
                } else {
                    $pattern = $matches[1];
                }
                $if = $i == 0 ? 'if' : ' elsif';
                $result .= sprintf($tpl, $if, $pattern, $rule['value']);
            }
        }

        return $result;
    }

    /**
     * Get IPs access list that can purge Varnish configuration for config file generation
     *
     * @return array
     */
    private function getTransformedAccessList(): array
    {
        $result = [];
        foreach ($this->accessList as $ip) {
            $ip = trim($ip);
            if (strlen($ip)) {
                $result[] = ['ip' => $ip];
            }
        }
        return $result;
    }
}
