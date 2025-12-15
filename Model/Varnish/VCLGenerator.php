<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\Varnish;

use Elgentos\VarnishExtended\Model\Config;
use Elgentos\VarnishExtended\Model\TemplateFactory;
use Magento\PageCache\Model\VclTemplateLocatorInterface;

class VCLGenerator extends \Magento\PageCache\Model\Varnish\VclGenerator
{
    /**
     * Paths to sensitive system directories that should never be accessible
     */
    private const BLOCKED_PATHS = [
        '/etc/passwd',
        '/etc/shadow',
        '/root',
        '/etc/ssh',
        '/proc',
        '/sys',
    ];

    /**
     * @var array|null Cached resolved blocked paths
     */
    private static ?array $resolvedBlockedPaths = null;

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
            'use_xkey_vmod' => (bool) $this->varnishExtendedConfig->getUseXkeyVmod(),
            'use_soft_purging' => (bool) $this->varnishExtendedConfig->getUseSoftPurging(),
            'pass_on_cookie_presence' => $this->varnishExtendedConfig->getPassOnCookiePresence(),
            'design_exceptions_code' => $this->getRegexForDesignExceptions(),
            'custom_vcl_prepend' => $this->getCustomVclContent($this->varnishExtendedConfig->getCustomVclPrependFile()),
            'custom_vcl_append' => $this->getCustomVclContent($this->varnishExtendedConfig->getCustomVclAppendFile()),
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

    /**
     * Get custom VCL content from file
     *
     * @param string $filePath
     * @return string
     */
    private function getCustomVclContent(string $filePath): string
    {
        if (empty($filePath)) {
            return '';
        }

        $realPath = realpath($filePath);
        if ($realPath === false) {
            return '';
        }

        // Security: Prevent access to sensitive system directories
        // Use cached resolved paths for performance
        if (self::$resolvedBlockedPaths === null) {
            self::$resolvedBlockedPaths = [];
            foreach (self::BLOCKED_PATHS as $blocked) {
                $blockedReal = realpath($blocked);
                if ($blockedReal !== false) {
                    self::$resolvedBlockedPaths[] = $blockedReal;
                }
            }
        }

        foreach (self::$resolvedBlockedPaths as $blockedReal) {
            // Check if path is within blocked directory
            // Use DIRECTORY_SEPARATOR to ensure we're checking actual directory boundaries
            if (strpos($realPath, $blockedReal) === 0) {
                // Allow only if the path is exactly the blocked path or starts with blocked path + separator
                if ($realPath === $blockedReal || 
                    (strlen($realPath) > strlen($blockedReal) && 
                     $realPath[strlen($blockedReal)] === DIRECTORY_SEPARATOR)) {
                    return '';
                }
            }
        }

        if (!is_readable($realPath)) {
            return '';
        }

        // Security: Limit file size to 1MB to prevent memory exhaustion
        $maxFileSize = 1024 * 1024; // 1MB
        $fileSize = filesize($realPath);
        if ($fileSize === false || $fileSize > $maxFileSize) {
            return '';
        }

        $content = file_get_contents($realPath);
        if ($content === false) {
            // Note: Silent failure is intentional for security reasons
            // Administrators can check Varnish logs if VCL generation has issues
            return '';
        }
        
        return $content;
    }
}
