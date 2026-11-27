<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Test\Unit\Model\Varnish;

use Elgentos\VarnishExtended\Model\Varnish\VCLTemplateLocator;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Filesystem\Directory\ReadFactory;
use Magento\Framework\Filesystem\Directory\ReadInterface;
use Magento\Framework\Filesystem\DirectoryList;
use Magento\Framework\Module\Dir;
use Magento\Framework\Module\Dir\Reader;
use Magento\PageCache\Exception\UnsupportedVarnishVersion;
use Magento\PageCache\Model\Varnish\VclTemplateLocator as BaseLocator;
use PHPUnit\Framework\TestCase;

class VCLTemplateLocatorTest extends TestCase
{
    public function testVersionSevenDoesNotFallBackToCoreTemplate(): void
    {
        $reader = $this->createMock(Reader::class);
        $reader->expects($this->once())
            ->method('getModuleDir')
            ->with(Dir::MODULE_ETC_DIR, 'Elgentos_VarnishExtended')
            ->willReturn('/module/etc');
        $readFactory = $this->createMock(ReadFactory::class);
        $readFactory->expects($this->never())->method('create');
        $locator = new VCLTemplateLocator(
            $reader,
            $readFactory,
            $this->createMock(ScopeConfigInterface::class),
            $this->createMock(DirectoryList::class)
        );

        $this->expectException(UnsupportedVarnishVersion::class);
        $locator->getTemplate(7);
    }

    public function testVersionSixUsesModuleTemplate(): void
    {
        $reader = $this->createMock(Reader::class);
        $reader->method('getModuleDir')->willReturn('/module/etc');
        $directory = $this->createMock(ReadInterface::class);
        $directory->method('getRelativePath')->with('/module/etc/varnish6.vcl')->willReturn('varnish6.vcl');
        $directory->method('readFile')->with('varnish6.vcl')->willReturn('module template');
        $readFactory = $this->createMock(ReadFactory::class);
        $readFactory->method('create')->with('/module/etc')->willReturn($directory);
        $scopeConfig = $this->createMock(ScopeConfigInterface::class);
        $scopeConfig->method('getValue')
            ->with(BaseLocator::VARNISH_6_CONFIGURATION_PATH)
            ->willReturn('varnish6.vcl');
        $locator = new VCLTemplateLocator(
            $reader,
            $readFactory,
            $scopeConfig,
            $this->createMock(DirectoryList::class)
        );

        self::assertSame('module template', $locator->getTemplate(6));
    }

    public function testExplicitInputFileRemainsSupportedForVersionSeven(): void
    {
        $reader = $this->createMock(Reader::class);
        $reader->expects($this->never())->method('getModuleDir');
        $directory = $this->createMock(ReadInterface::class);
        $directory->method('readFile')->with('custom.vcl')->willReturn('custom template');
        $readFactory = $this->createMock(ReadFactory::class);
        $readFactory->method('create')->with('/root')->willReturn($directory);
        $directoryList = $this->createMock(DirectoryList::class);
        $directoryList->method('getRoot')->willReturn('/root');
        $locator = new VCLTemplateLocator(
            $reader,
            $readFactory,
            $this->createMock(ScopeConfigInterface::class),
            $directoryList
        );

        self::assertSame('custom template', $locator->getTemplate(7, 'custom.vcl'));
    }
}
