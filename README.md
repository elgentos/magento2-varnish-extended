[![VCL Tests](https://github.com/elgentos/magento2-varnish-extended/actions/workflows/vcl_tests.yml/badge.svg)](https://github.com/elgentos/magento2-varnish-extended/actions/workflows/vcl_tests.yml)

# Elgentos_VarnishExtended

This module aims to add some extra features to the Varnish capabilities in Magento.

## Configurable tracking parameters

The [core Magento VCL](https://github.com/magento/magento2/blob/2.4-develop/app/code/Magento/PageCache/etc/varnish6.vcl) contains hard-coded marketing tracking parameters. Almost nobody changes them, but adding tracking parameters often used on your site highly increases hit rate.

This extension adds a field under Stores > Config > System > Full Page Cache > Varnish Configuration > Tracking Parameters in the backend to customize your own parameters.

**IMPORTANT NOTE**: this is not applied automatically! You need to use the optimized VCL:

```
bin/magento varnish:vcl:generate --export-version=6 --input-file=vendor/elgentos/magento2-varnish-extended/etc/varnish6.vcl --output-file=/data/web/varnish6.vcl
varnishadm vcl.load new-custom-vcl /data/web/varnish6.vcl
varnishadm vcl.use new-custom-vcl
```

## Marketing Parameters
### Info message when removing marketing parameters
Marketing parameters in the URL have a negative effect on the hit rate of the (Varnish) cache. You can list the marketing parameters that Varnish should remove to improve the hit rate.

Don't worry, removing these parameters will not break Magento, because these URL parameters are only processed in your browser, not on the server.

### Warning message when a marketing parameter matches our regular expression

**Warning:** you are trying to remove a marketing parameter from the URL that is also a *filterable product attribute* in Magento. Are you sure you want to remove it? Removing this parameter may prevent Magento from filtering on that attribute.

## Checking the Varnish hit rate

If you use RUMVision and when on Hypernode or Maxcluster, you can view the historical Varnish hit rate in RUMvision.

Otherwise you can do it manually:

```
wget --quiet https://raw.githubusercontent.com/olivierHa/check_varnish/master/check_varnish.py
chmod +x check_varnish.py
./check_varnish.py -f MAIN.cache_hit,MAIN.cache_miss -r
```

A good hit-rate for a B2C store is around 80-90%. For B2B, this would be lower, depending on how closed-off your catalog is.

## Auto-apply custom VCL

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

Needs at least Magento 2.4.7 and Varnish 6.4.

### Varnish 6 and 7

This module ships a single VCL template, `etc/varnish6.vcl`. Despite the name it is `vcl 4.1`
and contains no version-specific syntax, so the same file serves both Varnish 6 and Varnish 7.
CI runs the test suite against 6.0 and 7.7, plus the newest Varnish release as an informational job.

`--export-version=6` and `--export-version=7` therefore produce the same VCL, and you can move
your nodes from 6 to 7 without regenerating anything.

The version does matter for *which file* Magento looks up. Version 7 resolves to the filename
`varnish7.vcl`, which this module does not ship, so it used to fall through to Magento's stock
`varnish7.vcl` - silently handing you the core VCL instead of this one. `VCLTemplateLocator` now
maps both versions to the template in this module, so that no longer happens.

If you run into your VCL being generated without curly braces inside `for` and `if` directives, please check if you haven't still applied patch MDVA-4344. If you're running a recent Magento version, this patch isn't needed and breaks generation of the VCL.

## Running the test suite

The features of the VCL template are covered by a range of automated tests. To run the test suite, simply run `make test` in the `tests/varnish` folder:

```shell
cd tests/varnish
make test
```

The `make test` command will start a Docker container that has all the `.vtc` files mounted and runs the `varnishtest` command to run the tests.

This is the equivalent of running the following command in the `tests/varnish` folder:

```shell
varnishtest *.vtc
```

This will run the entire test suite, but you can also run individual tests by running the following command:

```shell
cd tests/varnish
make test_single TEST=purge.vtc
```

This will only run the tests inside the `purge.vtc` file, which is the equivalent of running `varnishtest purge.vtc`.

Both targets default to Varnish 7.7. Pass `VARNISH_IMAGE` to test against another version, the
same way CI does:

```shell
make test VARNISH_IMAGE=varnish:fresh
make test_single TEST=purge.vtc VARNISH_IMAGE=varnish:fresh
```

### Testing on Varnish 6.0

```shell
make test_varnish60
```

This builds `Dockerfile.varnish60` first, because the official `varnish:6.0` image ships without
varnish-modules: the template's `import cookie` cannot load there. No varnish-modules packages
exist for 6.0 either, so the Dockerfile builds `cookie` and `xkey` from source against the
matching `varnish-dev`.

Three tests are skipped on 6.0, for reasons unrelated to the VCL - see `VTC_SKIP_60` in the
Makefile:

- `design_exceptions_code` and `vary_cookie` use logexpect's `fail` command, added after 6.0;
- `invalid_req_method` asserts on `VCL_call PIPE`, which 6.0 groups under a different VSL
  transaction. The request still pipes correctly there.

Note that the `.vtc` files use `txreq -req` rather than the newer `-method` alias, so they parse
on every version in the matrix.

More information about the `varnishtest` program can be found  on the [varnish-cache.org documentation site](https://varnish-cache.org/docs/trunk/reference/varnishtest.html). You will also find information on the [Varnish Test Case syntax](https://varnish-cache.org/docs/trunk/reference/vtc.html).
