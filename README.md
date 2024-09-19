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

Now replace the relevant part:

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

## Compatibility

Needs at least Magento 2.4.7.
