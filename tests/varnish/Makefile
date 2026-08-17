VARNISH_IMAGE ?= varnish:7.7

DOCKER_RUN = docker run --platform linux/amd64 --rm \
	-v ${PWD}/../../etc/varnish6.vcl:/magento/etc/varnish6.vcl \
	-v ${PWD}:/magento/tests/varnish \
	-w /magento/tests/varnish/ $(VARNISH_IMAGE)

test:
	$(DOCKER_RUN) sh -c "/usr/bin/varnishtest -j 10 *.vtc"

test_single:
	@if [ -z "$(TEST)" ]; then \
		echo "Usage: make test_single TEST=<test-file-name>.vtc [VARNISH_IMAGE=varnish:fresh]"; \
		exit 1; \
	fi
	$(DOCKER_RUN) sh -c "/usr/bin/varnishtest $(TEST)"
