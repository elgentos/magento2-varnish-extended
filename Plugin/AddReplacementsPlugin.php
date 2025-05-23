<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Plugin;

use Elgentos\VarnishExtended\Model\Config;
use Magento\PageCache\Model\Varnish\VclGenerator;

/**
 * Interceptor for @see \Magento\PageCache\Model\Varnish\VclGenerator
 */
class AddReplacementsPlugin
{
    public function __construct(private readonly Config $config)
    {
    }

    /**
     * Intercepted method generateVcl.
     *
     * @param VclGenerator $subject
     * @param string       $result
     * @param int          $version
     * @param string|null  $inputFile
     *
     * @return string
     * @see \Magento\PageCache\Model\Varnish\VclGenerator::generateVcl
     * @SuppressWarnings(PHPMD.UnusedFormalParameter)
     */
    public function afterGenerateVcl(
        VclGenerator $subject,
        string $result,
        int $version,
        ?string $inputFile = null
    ): string {
        return strtr($result, $this->getReplacements());
    }

    protected function getReplacements(): array {
        return [
            '/* {{ tracking_parameters }} */' => $this->config->getTrackingParameters(),
        ];
    }
}
