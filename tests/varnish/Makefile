VARNISH_IMAGE ?= varnish:7.7

# Image built from Dockerfile.varnish60: the official varnish:6.0 has no varnish-modules,
# so the template's `import cookie` cannot load there.
VARNISH60_IMAGE = varnish-modules-test:6.0

# Three tests cannot run on 6.0, for reasons unrelated to the VCL:
#   design_exceptions_code, vary_cookie  - use logexpect's `fail` command, added after 6.0
#   invalid_req_method                   - asserts on VCL_call PIPE, which 6.0 groups
#                                          under a different VSL transaction
VTC_SKIP_60 = design_exceptions_code.vtc vary_cookie.vtc invalid_req_method.vtc
VTC_ALL     = $(sort $(wildcard *.vtc))
VTC_60      = $(filter-out $(VTC_SKIP_60),$(VTC_ALL))

DOCKER_RUN = docker run --platform linux/amd64 --rm \
	-v ${PWD}/../../etc/varnish6.vcl:/magento/etc/varnish6.vcl \
	-v ${PWD}:/magento/tests/varnish \
	-w /magento/tests/varnish/

test:
	$(DOCKER_RUN) $(VARNISH_IMAGE) sh -c "/usr/bin/varnishtest -j 10 $(VTC_ALL)"

test_single:
	@if [ -z "$(TEST)" ]; then \
		echo "Usage: make test_single TEST=<test-file-name>.vtc [VARNISH_IMAGE=varnish:fresh]"; \
		exit 1; \
	fi
	$(DOCKER_RUN) $(VARNISH_IMAGE) sh -c "/usr/bin/varnishtest $(TEST)"

build_varnish60:
	docker build --platform linux/amd64 -f Dockerfile.varnish60 -t $(VARNISH60_IMAGE) .

test_varnish60: build_varnish60
	$(DOCKER_RUN) --entrypoint sh $(VARNISH60_IMAGE) -c "/usr/bin/varnishtest -j 10 $(VTC_60)"

.PHONY: test test_single build_varnish60 test_varnish60
