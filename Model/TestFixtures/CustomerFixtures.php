<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\TestFixtures;

use Magento\Customer\Api\AccountManagementInterface;
use Magento\Customer\Api\CustomerRepositoryInterface;
use Magento\Customer\Api\Data\CustomerInterface;
use Magento\Customer\Api\Data\CustomerInterfaceFactory;
use Magento\Framework\Api\FilterBuilder;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Exception\NoSuchEntityException;
use Magento\Framework\Math\Random;
use Magento\Framework\Registry;
use Magento\Store\Api\WebsiteRepositoryInterface;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Creates disposable customers whose names carry a random token, so the test suite
 * can search cached HTML for that token to detect private-data leaks.
 */
class CustomerFixtures
{
    public const EMAIL_PREFIX = 'varnish-test+';
    public const EMAIL_DOMAIN = 'example.com';

    public function __construct(
        private readonly CustomerInterfaceFactory $customerFactory,
        private readonly CustomerRepositoryInterface $customerRepository,
        private readonly AccountManagementInterface $accountManagement,
        private readonly WebsiteRepositoryInterface $websiteRepository,
        private readonly StoreManagerInterface $storeManager,
        private readonly SearchCriteriaBuilder $searchCriteriaBuilder,
        private readonly FilterBuilder $filterBuilder,
        private readonly Random $random,
        private readonly Registry $registry,
    ) {
    }

    /**
     * @param array<int, array<string, mixed>> $spec
     * @return array{createdAt: string, customers: array<string, array<string, mixed>>}
     */
    public function create(array $spec): array
    {
        $customers = [];

        foreach ($spec as $index => $entry) {
            $key = (string) ($entry['key'] ?? ('customer-' . ($index + 1)));
            $website = $this->websiteRepository->get((string) ($entry['website'] ?? $entry['websiteId'] ?? '1'));
            $websiteId = (int) $website->getId();
            $groupId = (int) ($entry['groupId'] ?? 1);
            $storeId = $this->resolveStoreId($entry, $websiteId);

            $email = sprintf('%sw%d-g%d-%d@%s', self::EMAIL_PREFIX, $websiteId, $groupId, $index + 1, self::EMAIL_DOMAIN);
            $this->deleteIfExists($email, $websiteId);

            $token = strtolower($this->random->getRandomString(8));
            $password = 'Vt!' . $this->random->getRandomString(12) . 'aA1';

            $customer = $this->customerFactory->create();
            $customer->setEmail($email)
                ->setFirstname('Vtf' . $token)
                ->setLastname('Vtl' . $token)
                ->setGroupId($groupId)
                ->setWebsiteId($websiteId)
                ->setStoreId($storeId);

            $this->applyAttributes($customer, (array) ($entry['attributes'] ?? []));

            $saved = $this->accountManagement->createAccount($customer, $password);

            $customers[$key] = [
                'id' => (int) $saved->getId(),
                'email' => $email,
                'password' => $password,
                'firstname' => 'Vtf' . $token,
                'lastname' => 'Vtl' . $token,
                'token' => $token,
                'groupId' => $groupId,
                'websiteId' => $websiteId,
                'storeId' => $storeId,
                'storeCode' => $this->storeManager->getStore($storeId)->getCode(),
                'attributes' => (array) ($entry['attributes'] ?? []),
            ];
        }

        return [
            'createdAt' => date(DATE_ATOM),
            'customers' => $customers,
        ];
    }

    /**
     * @param array<string, mixed> $state
     */
    public function cleanup(array $state): int
    {
        $removed = 0;
        foreach ((array) ($state['customers'] ?? []) as $customer) {
            $id = (int) ($customer['id'] ?? 0);
            if ($id > 0 && $this->deleteById($id)) {
                $removed++;
            }
        }

        return $removed;
    }

    public function cleanupAll(): int
    {
        $filter = $this->filterBuilder
            ->setField(CustomerInterface::EMAIL)
            ->setConditionType('like')
            ->setValue(self::EMAIL_PREFIX . '%@' . self::EMAIL_DOMAIN)
            ->create();
        $criteria = $this->searchCriteriaBuilder->addFilters([$filter])->create();

        $removed = 0;
        foreach ($this->customerRepository->getList($criteria)->getItems() as $customer) {
            if ($this->deleteById((int) $customer->getId())) {
                $removed++;
            }
        }

        return $removed;
    }

    /**
     * @param array<string, mixed> $entry
     */
    private function resolveStoreId(array $entry, int $websiteId): int
    {
        if (!empty($entry['storeCode'])) {
            return (int) $this->storeManager->getStore((string) $entry['storeCode'])->getId();
        }
        if (!empty($entry['storeId'])) {
            return (int) $entry['storeId'];
        }

        return (int) $this->storeManager->getWebsite($websiteId)->getDefaultStore()->getId();
    }

    /**
     * @param array<string, mixed> $attributes
     */
    private function applyAttributes(CustomerInterface $customer, array $attributes): void
    {
        foreach ($attributes as $code => $value) {
            $setter = 'set' . str_replace('_', '', ucwords((string) $code, '_'));
            if (method_exists($customer, $setter)) {
                $customer->{$setter}($value);
                continue;
            }
            $customer->setCustomAttribute((string) $code, $value);
        }
    }

    private function deleteIfExists(string $email, int $websiteId): void
    {
        try {
            $existing = $this->customerRepository->get($email, $websiteId);
            $this->allowDelete();
            $this->customerRepository->delete($existing);
        } catch (NoSuchEntityException) {
            return;
        }
    }

    private function deleteById(int $id): bool
    {
        try {
            $this->allowDelete();
            return $this->customerRepository->deleteById($id);
        } catch (NoSuchEntityException) {
            return false;
        }
    }

    /**
     * The customer repository refuses deletes unless the "secure area" flag is set.
     * The CLI is a trusted context, and the only customers deleted here match the fixture email pattern.
     */
    private function allowDelete(): void
    {
        if ($this->registry->registry('isSecureArea') !== true) {
            $this->registry->register('isSecureArea', true, true);
        }
    }
}
