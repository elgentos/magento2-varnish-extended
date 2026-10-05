<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Console\Command;

use Elgentos\VarnishExtended\Model\TestFixtures\CustomerFixtures;
use Elgentos\VarnishExtended\Model\TestFixtures\EntityToucher;
use InvalidArgumentException;
use Magento\Framework\App\Area;
use Magento\Framework\App\State;
use Magento\Framework\Console\Cli;
use Magento\Framework\Serialize\Serializer\Json;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Throwable;

/**
 * Creates and removes disposable customers for the Varnish integration test suite,
 * and re-saves catalog entities so Magento emits a tag purge.
 *
 * Never run `create` or `cleanup` against production.
 */
class TestFixturesCommand extends Command
{
    private const ACTION_CREATE = 'create';
    private const ACTION_CLEANUP = 'cleanup';
    private const ACTION_TOUCH = 'touch';

    public function __construct(
        private readonly State $appState,
        private readonly Json $json,
        private readonly CustomerFixtures $customerFixtures,
        private readonly EntityToucher $entityToucher,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->setName('varnish:test:fixtures')
            ->setDescription('Manage disposable fixtures for the Varnish Playwright test suite (create|cleanup|touch)')
            ->addArgument('action', InputArgument::REQUIRED, 'create, cleanup or touch')
            ->addOption('spec', null, InputOption::VALUE_REQUIRED, 'JSON file describing the customers to create')
            ->addOption('website', null, InputOption::VALUE_REQUIRED, 'Website id or code (simple mode)', '1')
            ->addOption('group', null, InputOption::VALUE_REQUIRED, 'Comma separated customer group ids (simple mode)', '1')
            ->addOption('count', null, InputOption::VALUE_REQUIRED, 'Customers per group (simple mode)', '1')
            ->addOption(
                'attribute',
                null,
                InputOption::VALUE_REQUIRED | InputOption::VALUE_IS_ARRAY,
                'Extra customer attribute key=value, %d is replaced by the customer index (simple mode)',
                []
            )
            ->addOption('output', null, InputOption::VALUE_REQUIRED, 'Path of the JSON state file to write or read')
            ->addOption('all', null, InputOption::VALUE_NONE, 'cleanup: remove every customer that matches the fixture email pattern')
            ->addOption('sku', null, InputOption::VALUE_REQUIRED, 'touch: product SKU to re-save')
            ->addOption('category', null, InputOption::VALUE_REQUIRED, 'touch: category id to re-save');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        try {
            return $this->appState->emulateAreaCode(
                Area::AREA_ADMINHTML,
                fn (): int => $this->dispatch($input, $output)
            );
        } catch (Throwable $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return Cli::RETURN_FAILURE;
        }
    }

    private function dispatch(InputInterface $input, OutputInterface $output): int
    {
        $action = (string) $input->getArgument('action');

        return match ($action) {
            self::ACTION_CREATE => $this->create($input, $output),
            self::ACTION_CLEANUP => $this->cleanup($input, $output),
            self::ACTION_TOUCH => $this->touch($input, $output),
            default => $this->fail($output, sprintf('Unknown action "%s"', $action)),
        };
    }

    private function create(InputInterface $input, OutputInterface $output): int
    {
        $outputFile = (string) $input->getOption('output');
        if ($outputFile === '') {
            return $this->fail($output, '--output=<file> is required for create');
        }

        $specFile = (string) $input->getOption('spec');
        $spec = $specFile !== '' ? $this->readSpec($specFile) : $this->specFromSimpleOptions($input);

        $state = $this->customerFixtures->create($spec);

        file_put_contents($outputFile, $this->json->serialize($state));
        $output->writeln(sprintf(
            '<info>Created %d fixture customer(s), state written to %s</info>',
            count($state['customers']),
            $outputFile
        ));

        return Cli::RETURN_SUCCESS;
    }

    private function cleanup(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('all')) {
            $removed = $this->customerFixtures->cleanupAll();
        } else {
            $outputFile = (string) $input->getOption('output');
            if ($outputFile === '' || !is_file($outputFile)) {
                return $this->fail($output, '--output=<file> must point to an existing state file, or pass --all');
            }
            $state = $this->json->unserialize((string) file_get_contents($outputFile));
            $removed = $this->customerFixtures->cleanup(is_array($state) ? $state : []);
            unlink($outputFile);
        }

        $output->writeln(sprintf('<info>Removed %d fixture customer(s)</info>', $removed));

        return Cli::RETURN_SUCCESS;
    }

    private function touch(InputInterface $input, OutputInterface $output): int
    {
        $sku = (string) $input->getOption('sku');
        $categoryId = (string) $input->getOption('category');

        if ($sku === '' && $categoryId === '') {
            return $this->fail($output, 'touch needs --sku=<sku> and/or --category=<id>');
        }

        if ($sku !== '') {
            $this->entityToucher->touchProduct($sku);
            $output->writeln(sprintf('<info>Re-saved product %s</info>', $sku));
        }

        if ($categoryId !== '') {
            $this->entityToucher->touchCategory((int) $categoryId);
            $output->writeln(sprintf('<info>Invalidated category %s (clean_cache_by_tags)</info>', $categoryId));
        }

        return Cli::RETURN_SUCCESS;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function readSpec(string $specFile): array
    {
        if (!is_file($specFile)) {
            throw new InvalidArgumentException(sprintf('Spec file %s does not exist', $specFile));
        }

        $spec = $this->json->unserialize((string) file_get_contents($specFile));
        if (!is_array($spec)) {
            throw new InvalidArgumentException('Spec file must contain a JSON array of customers');
        }

        return array_values($spec);
    }

    /**
     * Turns --website/--group/--count/--attribute into the same spec shape as --spec.
     *
     * @return array<int, array<string, mixed>>
     */
    private function specFromSimpleOptions(InputInterface $input): array
    {
        $website = (string) $input->getOption('website');
        $groups = array_filter(array_map('trim', explode(',', (string) $input->getOption('group'))));
        $count = max(1, (int) $input->getOption('count'));

        $attributes = [];
        foreach ((array) $input->getOption('attribute') as $pair) {
            if (!str_contains((string) $pair, '=')) {
                continue;
            }
            [$key, $value] = explode('=', (string) $pair, 2);
            $attributes[trim($key)] = $value;
        }

        $spec = [];
        $index = 0;
        foreach ($groups as $groupId) {
            for ($n = 1; $n <= $count; $n++) {
                $index++;
                $spec[] = [
                    'key' => sprintf('w%s-g%s-%d', $website, $groupId, $n),
                    'website' => $website,
                    'groupId' => (int) $groupId,
                    'attributes' => array_map(
                        static fn (string $value): string => str_replace('%d', (string) $index, $value),
                        $attributes
                    ),
                ];
            }
        }

        return $spec;
    }

    private function fail(OutputInterface $output, string $message): int
    {
        $output->writeln('<error>' . $message . '</error>');

        return Cli::RETURN_FAILURE;
    }
}
