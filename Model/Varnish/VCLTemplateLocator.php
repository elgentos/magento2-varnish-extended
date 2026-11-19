<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\Varnish;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Exception\FileSystemException;
use Magento\Framework\Module\Dir;
use Magento\Framework\Module\Dir\Reader;
use Magento\Framework\Filesystem\DirectoryList;
use Magento\Framework\Filesystem\Directory\ReadFactory;
use Magento\PageCache\Model\Config as BaseConfig;
use Magento\PageCache\Model\VclTemplateLocatorInterface;
use Magento\PageCache\Exception\UnsupportedVarnishVersion;

use \Magento\PageCache\Model\Varnish\VclTemplateLocator as BaseLocator;

class VCLTemplateLocator implements VclTemplateLocatorInterface
{
    private array $supportedVarnishVersions = [
        BaseLocator::VARNISH_SUPPORTED_VERSION_6 => BaseLocator::VARNISH_6_CONFIGURATION_PATH,
    ];

    public function __construct(
        private readonly Reader $reader,
        private readonly ReadFactory $readFactory,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly DirectoryList $directoryList
    ) {
        if (defined('Magento\PageCache\Model\Varnish\VclTemplateLocator::VARNISH_SUPPORTED_VERSION_7')
            && defined('Magento\PageCache\Model\Config::VARNISH_7_CONFIGURATION_PATH')
        ) {
            $this->supportedVarnishVersions[BaseLocator::VARNISH_SUPPORTED_VERSION_7] = BaseConfig::VARNISH_7_CONFIGURATION_PATH;
        }
    }

    /**
     * @inheritdoc
     */
    public function getTemplate($version, $inputFile = null)
    {
        if ($inputFile) {
            $reader = $this->readFactory->create($this->directoryList->getRoot());
            return $reader->readFile($inputFile);
        }

        $template = null;
        foreach (['Elgentos_VarnishExtended', 'Magento_PageCache'] as $module) {
            $moduleEtcPath  = $this->reader->getModuleDir(Dir::MODULE_ETC_DIR, $module);
            $configFilePath = $moduleEtcPath . '/' . $this->scopeConfig->getValue($this->getVclTemplatePath($version));
            $directoryRead  = $this->readFactory->create($moduleEtcPath);
            $configFilePath = $directoryRead->getRelativePath($configFilePath);
            try {
                $template = $directoryRead->readFile($configFilePath);
            } catch (FileSystemException $e) {
                continue;
            }
            // No exception, so we can continue
            break;
        }

        if ($template === null) {
            throw new UnsupportedVarnishVersion(__("Failed to find VCL template for version {$version}"));
        }

        return $template;
    }

    /**
     * Get VCL template config path
     *
     * @param int $version Varnish version
     * @return string
     * @throws UnsupportedVarnishVersion
     */
    private function getVclTemplatePath($version)
    {
        if (!isset($this->supportedVarnishVersions[$version])) {
            throw new UnsupportedVarnishVersion(__('Unsupported varnish version'));
        }

        return $this->supportedVarnishVersions[$version];
    }
}
