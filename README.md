# Elgentos_VarnishExtended

This module aims to add some extra features to the Varnish capabilities in Magento.

## Configurable tracking parameters

The [core Magento VCL](https://github.com/magento/magento2/blob/2.4-develop/app/code/Magento/PageCache/etc/varnish6.vcl) contains hard-coded marketing tracking parameters. Almost nobody changes them, but adding tracking parameters often used on your site highly increases hit rate.

This extension adds a field under Stores > Config > System > Full Page Cache > Varnish Configuration > Tracking Parameters in the backend to customize your own parameters.

**IMPORTANT NOTE**: this is not applied automatically! You need to use a custom VCL and replace the marketing get parameters part with the new part with the placeholder;

You can use the core Magento VCL as a basis;
```
cp vendor/magento/module-page-cache/etc/varnish6.vcl custom-varnish6.vcl
```

Or use the custom optimized VCL as explained in the subsection "Custom optimized VCL" of this readme. 

Now replace the relevant part with this part, which includes the placeholder:

```
    # Remove all marketing get parameters to minimize the cache objects
    if (req.url ~ "(\?|&)(/* {{ tracking_parameters }} */)=") {
        set req.url = regsuball(req.url, "(/* {{ tracking_parameters }} */)=[-_A-z0-9+(){}%.]+&?", "");
        set req.url = regsub(req.url, "[?|&]+$", "");
    }
```

Then, you need to generate the new VCL and apply it;

```
bin/magento varnish:vcl:generate --export-version=6 ---input-file=custom-varnish6.vcl -output-file=/data/web/varnish6.vcl
varnishadm vcl.load new-custom-vcl /data/web/varnish6.vcl
varnishadm vcl.use new-custom-vcl
```

## Checking the Varnish hit rate

It is advised to check the Varnish hit rate before and after applying these changes, so you can see whether the hit rate actually improved.

```
wget --quiet https://raw.githubusercontent.com/olivierHa/check_varnish/master/check_varnish.py
chmod +x check_varnish.py
./check_varnish.py -f MAIN.cache_hit,MAIN.cache_miss -r
```

A good hit-rate for a B2C store is around 80-90%. For B2B, this would be lower, depending on how closed-off your catalog is.

## Custom optimized VCL

You are encouraged to use the custom optimized VCL found here; https://gist.github.com/peterjaap/006169c5d95eeffde3a1cc062de1b514

You can place it in your Git repo in `app/etc/varnish6.vcl` and automate applying it through [Deployer](https://deployer.org/) on each deploy with the following Deployer task.

```
desc('Auto-apply VCL when custom VCL exists');
task('vcl:auto-apply', function () {
    if (test('[ -f {{release_path}}/app/etc/varnish6.vcl ]')) {
        $timestamp = date('YmdHis');
        run('{{bin/php}} {{release_path}}/bin/magento varnish:vcl:generate --export-version=6 --input-file={{release_path}}/app/etc/varnish6.vcl --output-file=/data/web/varnish6.vcl');
        run('varnishadm vcl.load vcl' . $timestamp . ' /data/web/varnish6.vcl');
        run('varnishadm vcl.use vcl' . $timestamp);
    }
})->select('stage=production');
```

Contrary to popular belief, loading & activating ('using') a new VCL does not purge the cache objects already in Varnish. However, the new VCL might change how future requests are processed, which could result in cached items being evicted sooner or fetched differently.

## Notable differences
1. VCL Version and Compatibility
- **Magento VCL**: Uses vcl 4.0 for compatibility, even though Varnish version 6 or 7 is used.
- **Optimized VCL**: Uses vcl 4.1—a more current version—while still maintaining compatibility with Varnish 6 and 7.
  
2. Request Handling (sub vcl_recv)
- **Magento VCL**: Focuses on request normalization (removing marketing parameters, handling cache control for specific URL paths) but lacks improvements like query parameter sorting or more sophisticated request cleaning.
- **Optimized VCL**:
  - Query String Optimization: Sorts query parameters using std.querysort() to improve cache efficiency.
  - Empty Query Parameter Removal: Eliminates empty query strings for normalization.
  - Host Header Cleanup: Removes port numbers from the Host header for better cache key normalization.
  - Httpoxy Vulnerability Mitigation: Unsets the proxy header to mitigate potential vulnerabilities.
  - Grace Period for Healthy Backend: Dynamically adjusts the grace period based on backend health.
  - Advanced Query Param Removal: Removes more marketing-related query parameters compared to the original **Magento VCL**, optimizing cache objects even further.

3. Cookie and Header Management
- **Magento VCL**: Uses std.collect() on cookies but doesn't perform additional cookie header collapsing or aggressive cleanup of unnecessary headers.
- **Optimized VCL**: Collapses multiple Cookie headers and removes headers like proxy for more efficient processing and enhanced security.

4. Cache Key Generation (sub vcl_hash)
- **Magento VCL**: Hashes certain request headers and applies logic for GraphQL and Magento's X-Magento-Vary cookies, but has room for better structure and logic consolidation.
- **Optimized VCL**:
  - Consolidation: Handles GraphQL requests and Magento cache ID more elegantly by ensuring either the X-Magento-Cache-Id or fallback headers (Store, Content-Currency) are used for hashing.
  - General Security: Adds more structured logic for SSL offloading, improving HTTPS handling and hash key integrity.

5. Backend Response Handling (sub vcl_backend_response)
- **Magento VCL**:
  - Basic TTL Control: Caches 200 and 404 responses but unsets cookies in a less optimized way.
  - Hit-For-Pass: Implements a basic Hit-For-Pass strategy when responses are uncachable.
- **Optimized VCL**:
  - Grace and Stale Content: Keeps stale content for up to 3 days, using asynchronous revalidation to refresh the cache while still serving expired content.
  - Set-Cookie Header: Proactively unsets Set-Cookie for cacheable content (GET and HEAD requests) to improve cache hit rates.
  - Strict TTL Control: Sets a short (120s) TTL for uncacheable content and mismatched GraphQL cache IDs to avoid excessive pass-throughs.

6. Header Management on Delivery (sub vcl_deliver)
- **Magento VCL**: Unsets a range of headers such as X-Magento-Tags, X-Powered-By, and Server, but includes debugging information in a basic form.
- **Optimized VCL**:
  - Improved Debugging: Adds more specific debugging headers (X-Magento-Cache-Debug), including detailed cache hit/miss reporting.
  - More Aggressive Header Cleanup: Unsets additional headers like X-Varnish, Via, and Link to streamline responses and reduce unnecessary data sent to clients.

7. Security Enhancements
- **Magento VCL**: Implements basic security by removing sensitive headers but lacks more advanced threat mitigations.
- **Optimized VCL**: Includes explicit X-Forwarded-Proto logic for HTTPS, better security header management (e.g., removing proxy headers), and optimizations like the removal of the HTTPoxy vulnerability.

8. GraphQL Request Handling
- **Magento VCL**: Caches only authorized GraphQL requests with appropriate X-Magento-Cache-Id headers, but with slightly less efficient logic for hashing and caching.
- **Optimized VCL**: More streamlined and optimized logic for handling GraphQL cache keys, including fallback mechanisms to ensure cache key integrity even if X-Magento-Cache-Id is not set.

9. Simplified Logic and Performance Improvements
- The **Optimized VCL** is much cleaner, with more consolidated logic, fewer repetitive conditions, and more robust performance enhancements (e.g., cookie collapsing, better query handling, etc.). It also introduces enhanced debugging features and more granular cache control based on real-time conditions such as backend health and dynamic grace periods.

## Compatibility

Needs at least Magento 2.4.7.
