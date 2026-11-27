<?php

declare(strict_types=1);

namespace Elgentos\VarnishExtended\Model\TestFixtures;

use Magento\Catalog\Api\CategoryRepositoryInterface;
use Magento\Catalog\Api\ProductRepositoryInterface;
use Magento\Framework\App\CacheInterface;
use Magento\Framework\DataObject\IdentityInterface;
use Magento\Framework\Event\ManagerInterface;
use Magento\Store\Model\Store;

/**
 * Invalidates a catalog entity the way a save does, so the Varnish purge path
 * (clean_cache_by_tags -> InvalidateVarnishObserver -> PURGE) can be observed end to end.
 */
class EntityToucher
{
    public function __construct(
        private readonly ProductRepositoryInterface $productRepository,
        private readonly CategoryRepositoryInterface $categoryRepository,
        private readonly CacheInterface $cache,
        private readonly ManagerInterface $eventManager,
    ) {
    }

    /**
     * A real product save: it also triggers indexers and their follow-up purges, like an admin save does.
     */
    public function touchProduct(string $sku): void
    {
        $product = $this->productRepository->get($sku, true, Store::DEFAULT_STORE_ID, true);
        $product->setStoreId(Store::DEFAULT_STORE_ID);
        $this->productRepository->save($product);
    }

    /**
     * A no-op category save fails on many installs ("URL key for specified store already exists"),
     * so this dispatches the same cache invalidation that AbstractModel::afterSave() dispatches.
     */
    public function touchCategory(int $categoryId): void
    {
        $category = $this->categoryRepository->get($categoryId, Store::DEFAULT_STORE_ID);
        if ($category instanceof IdentityInterface) {
            $this->cache->clean($category->getIdentities());
        }
        $this->eventManager->dispatch('clean_cache_by_tags', ['object' => $category]);
    }
}
