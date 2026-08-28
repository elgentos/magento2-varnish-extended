test:
	docker run --rm --name varnishtest -v  ${PWD}/../../etc/varnish6.vcl:/magento/etc/varnish6.vcl -v  ${PWD}:/magento/tests/varnish -w /magento/tests/varnish/ varnish:latest sh -c "/usr/bin/varnishtest -j 10 *.vtc"

test_single:
	@if [ -z "$(TEST)" ]; then \
		echo "Usage: make test-single TEST=<test-file-name>.vtc"; \
		exit 1; \
	fi
	docker run --rm --name varnishtest -v  ${PWD}/../../etc/varnish6.vcl:/magento/etc/varnish6.vcl -v  ${PWD}:/magento/tests/varnish -w /magento/tests/varnish/ varnish:latest sh -c "/usr/bin/varnishtest $(TEST)"
