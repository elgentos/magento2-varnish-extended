<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Console\Command;

use Elgentos\VarnishExtended\Model\Config as VarnishExtendedConfig;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Console\Cli;
use Magento\Framework\Filesystem\DriverPool;
use Magento\Framework\Filesystem\File\WriteFactory;
use Magento\Framework\Serialize\Serializer\Json;
use Magento\PageCache\Console\Command\GenerateVclCommand as MagentoGenerateVclCommand;
use Magento\PageCache\Model\Config;
use Magento\PageCache\Model\VclGeneratorInterfaceFactory;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class GenerateVclCommand extends MagentoGenerateVclCommand
{
    public function __construct(
        private readonly VclGeneratorInterfaceFactory $vclGeneratorFactory,
        private readonly WriteFactory $writeFactory,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly Json $serializer,
        private readonly Config $pageCacheConfig,
        private readonly VarnishExtendedConfig $varnishExtendedConfig,
    ) {
        parent::__construct(
            $vclGeneratorFactory,
            $writeFactory,
            $scopeConfig,
            $serializer
        );
    }

    protected $inputToVclMap = [
        self::ACCESS_LIST_OPTION => 'accessList',
        self::BACKEND_PORT_OPTION => 'backendPort',
        self::BACKEND_HOST_OPTION => 'backendHost',
        self::GRACE_PERIOD_OPTION => 'gracePeriod',
    ];

    /**
     * Enable BFCache option name
     */
    public const ENABLE_BFCACHE_OPTION = 'enable-bfcache';

    /**
     * @inheritdoc
     */
    protected function configure(): void
    {
        $this->setName('varnish:vcl:generate')
            ->setDescription('Generates Varnish VCL and echos it to the command line')
            ->setDefinition($this->getExtendedOptionList());
    }

    /**
     * Get extended list of options for the command
     *
     * @return InputOption[]
     */
    private function getExtendedOptionList(): array
    {
        return [
            new InputOption(
                self::ACCESS_LIST_OPTION,
                null,
                InputOption::VALUE_REQUIRED | InputOption::VALUE_IS_ARRAY,
                'IPs access list that can purge Varnish',
                ['localhost']
            ),
            new InputOption(
                self::BACKEND_HOST_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Host of the web backend',
                'localhost'
            ),
            new InputOption(
                self::BACKEND_PORT_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Port of the web backend',
                8080
            ),
            new InputOption(
                self::EXPORT_VERSION_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'The version of Varnish file',
                \Magento\PageCache\Model\Varnish\VclTemplateLocator::VARNISH_SUPPORTED_VERSION_6
            ),
            new InputOption(
                self::GRACE_PERIOD_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Grace period in seconds',
                300
            ),
            new InputOption(
                self::INPUT_FILE_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Input file to generate vcl from'
            ),
            new InputOption(
                self::OUTPUT_FILE_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Path to the file to write vcl'
            ),
            new InputOption(
                self::ENABLE_BFCACHE_OPTION,
                null,
                InputOption::VALUE_REQUIRED,
                'Enable Back-Forward Cache (BFCache)',
                1
            ),
        ];
    }

    /**
     * @inheritdoc
     */
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $errors = $this->validate($input);
        if ($errors) {
            foreach ($errors as $error) {
                $output->writeln('<error>'.$error.'</error>');

                return Cli::RETURN_FAILURE;
            }
        }

        try {
            $inputFile = $input->getOption(self::INPUT_FILE_OPTION);
            $outputFile = $input->getOption(self::OUTPUT_FILE_OPTION);
            $varnishVersion = $input->getOption(self::EXPORT_VERSION_OPTION);
            $vclParameters = array_merge($this->getVclParameters($input), [
                'sslOffloadedHeader' => $this->varnishExtendedConfig->getSslOffloadedHeader(),
                'trackingParameters' => $this->varnishExtendedConfig->getTrackingParameters(),
                'designExceptions' => $this->varnishExtendedConfig->getDesignExceptions(),
                'ipForwardHeader' => $this->varnishExtendedConfig->getIpForwardHeader(),
            ]);
            $vclGenerator = $this->vclGeneratorFactory->create($vclParameters);
            $vcl = $vclGenerator->generateVcl($varnishVersion, $inputFile);

            if ($outputFile) {
                $writer = $this->writeFactory->create($outputFile, DriverPool::FILE, 'w+');
                $writer->write($vcl);
                $writer->close();
            } else {
                $output->writeln($vcl);
            }

            return Cli::RETURN_SUCCESS;
        } catch (\Exception $e) {
            $output->writeln('<error>'.$e->getMessage().'</error>');
            if ($output->getVerbosity() >= OutputInterface::VERBOSITY_VERBOSE) {
                $output->writeln($e->getTraceAsString());
            }

            return Cli::RETURN_FAILURE;
        }
    }

    /**
     * Get VCL parameters from input
     *
     * @param InputInterface $input
     * @return array
     */
    private function getVclParameters(InputInterface $input): array
    {
        $parameters = [];

        $enableBfcacheOptionPassed = $input->getParameterOption('--' . self::ENABLE_BFCACHE_OPTION, false, true) !== false;
        $accessListOptionPassed = $input->getParameterOption('--' . self::ACCESS_LIST_OPTION, false, true) !== false;
        $backendHostOptionPassed = $input->getParameterOption('--' . self::BACKEND_HOST_OPTION, false, true) !== false;
        $backendPortOptionPassed = $input->getParameterOption('--' . self::BACKEND_PORT_OPTION, false, true) !== false;
        $gracePeriodOptionPassed = $input->getParameterOption('--' . self::GRACE_PERIOD_OPTION, false, true) !== false;

        $parameters['enableBfcache'] = $enableBfcacheOptionPassed ?: $this->varnishExtendedConfig->getEnableBfcache();
        $parameters['accessList'] = ($accessListOptionPassed ? $input->getOption(self::ACCESS_LIST_OPTION) : $this->varnishExtendedConfig->getAccessList());
        $parameters['backendHost'] = ($backendHostOptionPassed ? $input->getOption(self::BACKEND_HOST_OPTION) : $this->varnishExtendedConfig->getBackendHost());
        $parameters['backendPort'] = ($backendPortOptionPassed ? $input->getOption(self::BACKEND_PORT_OPTION) : $this->varnishExtendedConfig->getBackendPort());
        $parameters['gracePeriod'] = ($gracePeriodOptionPassed ? $input->getOption(self::GRACE_PERIOD_OPTION) : $this->varnishExtendedConfig->getGracePeriod());

        return $parameters;
    }

    /**
     * Maps input keys to vcl parameters
     *
     * @param InputInterface $input
     * @return array
     */
    protected function inputToVclParameters(InputInterface $input): array
    {
        $parameters = [];

        foreach ($this->inputToVclMap as $inputKey => $vclKey) {
            $parameters[$vclKey] = $input->getOption($inputKey);
        }

        return $parameters;
    }

    /**
     * Input validation
     *
     * @param InputInterface $input
     * @return array
     */
    protected function validate(InputInterface $input): array
    {
        $errors = [];

        if ($input->hasOption(self::BACKEND_PORT_OPTION)
            && ($input->getOption(self::BACKEND_PORT_OPTION) < 0
                || $input->getOption(self::BACKEND_PORT_OPTION) > 65535)
        ) {
            $errors[] = 'Invalid backend port value';
        }

        if ($input->hasOption(self::GRACE_PERIOD_OPTION)
            && $input->getOption(self::GRACE_PERIOD_OPTION) < 0
        ) {
            $errors[] = 'Grace period can\'t be lower than 0';
        }

        return $errors;
    }
}
