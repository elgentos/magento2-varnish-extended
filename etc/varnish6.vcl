# Optimized VCL for Magento 2 with Xkey support

vcl 4.1;

import cookie;
import std;
{{if use_xkey_vmod}}
import xkey;
{{/if}}

# The minimal Varnish version is 6.0
# For SSL offloading, pass the following header in your proxy server or load balancer: '{{var ssl_offloaded_header }}: https'

backend default {
    .host = "{{var host}}";
    .port = "{{var port}}";
    .first_byte_timeout = 600s;
    .probe = {
        .url = "/health_check.php";
        .timeout = 2s;
        .interval = 5s;
        .window = 10;
        .threshold = 5;
   }
}

# Access control list for purge requests
acl purge {
{{for item in access_list}}
    "{{var item.ip}}";
{{/for}}
}

sub vcl_recv {
    # Remove empty query string parameters
    # e.g.: www.example.com/index.html?
    if (req.url ~ "\?$") {
        set req.url = regsub(req.url, "\?$", "");
    }

    # Remove port number from host header if set
    if (req.http.Host ~ ":[0-9]+$") {
        set req.http.Host = regsub(req.http.Host, ":[0-9]+$", "");
    }

    # Sorts query string parameters alphabetically for cache normalization purposes,
    # only when there are multiple parameters
    if (req.url ~ "\?.+&.+") {
        set req.url = std.querysort(req.url);
    }

    # Reduce grace to the configured setting if the backend is healthy
    # In case of an unhealthy backend, the original grace is used
    if (std.healthy(req.backend_hint)) {
        set req.grace = {{var grace_period}}s;
        std.log("Grace period set to {{var grace_period}} seconds for healthy backend");
    }

    # Allow cache purge via Ctrl-Shift-R or Cmd-Shift-R for IP's in purge ACL list
    if (req.http.pragma ~ "no-cache" || req.http.Cache-Control ~ "no-cache") {
        if (client.ip ~ purge) {
            set req.hash_always_miss = true;
        }
    }

    # Purge logic to remove objects from the cache
    # Tailored to Magento's cache invalidation mechanism
    # The X-Magento-Tags-Pattern value is matched to the tags in the X-Magento-Tags header
    # If X-Magento-Tags-Pattern is not set, a URL-based purge is executed
    if (req.method == "PURGE") {
        if (client.ip !~ purge) {
            return (synth(405));
        }

        # If the X-Magento-Tags-Pattern header is not set, just use regular URL-based purge
        if (!req.http.X-Magento-Tags-Pattern) {
            return (purge);
        }

{{if use_xkey_vmod}}
        # Full Page Cache flush
        if (req.http.X-Magento-Tags-Pattern == ".*") {
            # If Magento wants to flush everything with .* regexp, it's faster to remove them
            # using the 'all' tag. This tag is automatically added by this VCL when a backend
            # is generated (see vcl_backend_response).
            if (req.http.X-Magento-Purge-Soft) {
                set req.http.n-gone = xkey.softpurge("all");
            } else {
                set req.http.n-gone = xkey.purge("all");
            }
            return (synth(200, req.http.n-gone));
        } elseif (req.http.X-Magento-Tags-Pattern) {
            # replace "((^|,)cat_c(,|$))|((^|,)cat_p(,|$))" to be "cat_c cat_p"
            set req.http.X-Magento-Tags-Pattern = regsuball(req.http.X-Magento-Tags-Pattern, "[^a-zA-Z0-9_-]+" ," ");
            set req.http.X-Magento-Tags-Pattern = regsuball(req.http.X-Magento-Tags-Pattern, "(^ *)|( *$)" ,"");
            if (req.http.X-Magento-Purge-Soft) {
                set req.http.n-gone = xkey.softpurge(req.http.X-Magento-Tags-Pattern);
            } else {
                set req.http.n-gone = xkey.purge(req.http.X-Magento-Tags-Pattern);
            }
            return (synth(200, req.http.n-gone));
        }
{{else}}
        ban("obj.http.X-Magento-Tags ~ " + req.http.X-Magento-Tags-Pattern);
        return (synth(200, "0"));

{{/if}}
    }

    if (req.method != "GET" &&
        req.method != "HEAD" &&
        req.method != "PUT" &&
        req.method != "POST" &&
        req.method != "PATCH" &&
        req.method != "TRACE" &&
        req.method != "OPTIONS" &&
        req.method != "DELETE") {
          return (pipe);
    }

    # We only deal with GET and HEAD by default
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # Bypass health check requests
    if (req.url == "/health_check.php") {
        return (pass);
    }


    # Media files caching
    if (req.url ~ "^/(pub/)?media/") {
{{if enable_media_cache}}
            unset req.http.Https;
            unset req.http.{{var ssl_offloaded_header}};
            unset req.http.Cookie;
{{else}}
            return (pass);
{{/if}}
    }

    # Static files caching
    if (req.url ~ "^/(pub/)?static/") {
{{if enable_static_cache}}
            unset req.http.Https;
            unset req.http.{{var ssl_offloaded_header}};
            unset req.http.Cookie;
{{else}}
            return (pass);
{{/if}}
    }

    # Collapse multiple cookie headers into one.
    # We do this, because clients often send a Cookie header for each cookie they have.
    # We want to join them all together with the ';' separator, so we can parse them in one batch.
    std.collect(req.http.Cookie, ";");

    # Parse the cookie header.
    # This means that we can use the cookie functions to check for cookie existence,
    # values, etc down the line.
    cookie.parse(req.http.Cookie);

{{for item in pass_on_cookie_presence}}
    if (req.http.Cookie ~ "{{var item.regex}}") {
        return (pass);
    }
{{/for}}

    # Remove all marketing/tracking get parameters to minimize the cache objects
    if (req.url ~ "(\?|&)({{var tracking_parameters}})=") {
        set req.url = regsuball(req.url, "({{var tracking_parameters}})=[-_A-z0-9+(){}%.]+&?", "");
        set req.url = regsub(req.url, "[?|&]+$", "");
    }

    # Bypass authenticated GraphQL requests without a X-Magento-Cache-Id
    if (req.url ~ "/graphql" && !req.http.X-Magento-Cache-Id && req.http.Authorization ~ "^Bearer") {
        return (pass);
    }

    return (hash);
}

sub vcl_hash {
    # For non-graphql requests we add the value of the Magento Vary cookie to the
    # object hash. This vary cookie can contain things like currency, store code, etc.
    # These variations are typically rendered server-side, so we need to cache them separately.
    if (req.url !~ "/graphql" && cookie.isset("X-Magento-Vary")) {
        hash_data(cookie.get("X-Magento-Vary"));
    }

    # To make sure http users don't see ssl warning
    hash_data(req.http.{{var ssl_offloaded_header}});

    {{var design_exceptions_code}}

    # For graphql requests we execute the process_graphql_headers subroutine
    if (req.url ~ "/graphql") {
        call process_graphql_headers;
    }

    # Don't strip trailing slash for the homepage
    if(req.url == "/") {
        hash_data(req.url);
    } else {
        # Strip trailing slash from URL for cache normalization
        hash_data(regsub(req.url, "\/$", ""));
    }

    # Always include the host header in the hash to separate different websites
    hash_data(req.http.Host);

    return(lookup);
}

sub process_graphql_headers {
    # The X-Magento-Cache-Id header is used by graphql clients to let the backend
    # know which variant it is. It's basically the same as the Vary # cookie, but
    # for graphql requests.
    if (req.http.X-Magento-Cache-Id) {
        hash_data(req.http.X-Magento-Cache-Id);

        # When the frontend stops sending the auth token, make sure users stop getting results cached for logged-in users
        if (req.http.Authorization ~ "^Bearer") {
            hash_data("Authorized");
        }
    }

    # If store header is specified by client, add it to the hash
    if (req.http.Store) {
        hash_data(req.http.Store);
    }

    # If content-currency header is specified, add it to the hash
    if (req.http.Content-Currency) {
        hash_data(req.http.Content-Currency);
    }
}

sub vcl_backend_response {
    # Serve stale content for one day after object expiration while a fresh
    # version is fetched in the background.
    set beresp.grace = 1d;

{{if use_xkey_vmod}}
    if (beresp.http.X-Magento-Tags) {
        # set space separated xkey with "all" tag, allowing for fast full purges
        set beresp.http.XKey = regsuball(beresp.http.X-Magento-Tags, ",", " ") + " all";
        unset beresp.http.X-Magento-Tags;
    }
{{/if}}

    # All text-based content can be parsed as ESI
    if (beresp.http.content-type ~ "text") {
        set beresp.do_esi = true;
    }

    # Cache HTTP 200 responses
{{if enable_404_cache}}
    if (beresp.status != 200 && beresp.status != 404) {
{{else}}
    if (beresp.status != 200) {
{{/if}}
        set beresp.ttl = 120s;
        set beresp.uncacheable = true;
        return (deliver);
    }

    # Don't cache if the request cache ID doesn't match the response cache ID for graphql requests
    if (bereq.url ~ "/graphql" && bereq.http.X-Magento-Cache-Id && bereq.http.X-Magento-Cache-Id != beresp.http.X-Magento-Cache-Id) {
       set beresp.ttl = 120s;
       set beresp.uncacheable = true;
       return (deliver);
    }

    # Remove the Set-Cookie header for cacheable content
    # Only for HTTP GET & HTTP HEAD requests
    # We remove the Set-Cookie header from the VCL response, because we want to keep
    # the objects in the cache anonymous.
    if (beresp.ttl > 0s && (bereq.method == "GET" || bereq.method == "HEAD")) {
        unset beresp.http.Set-Cookie;
    }
}

sub vcl_deliver {
    if (obj.uncacheable) {
        set resp.http.X-Magento-Cache-Debug = "UNCACHEABLE";
    } else if (obj.hits > 0 && obj.ttl > 0s) {
        set resp.http.X-Magento-Cache-Debug = "HIT";
    } else if (obj.hits > 0 && obj.ttl <= 0s) {
        set resp.http.X-Magento-Cache-Debug = "HIT-GRACE";
    } else if(req.hash_always_miss) {
        set resp.http.X-Magento-Cache-Debug = "MISS-FORCED";
    } else {
        set resp.http.X-Magento-Cache-Debug = "MISS";
    }

    # Let browser and Cloudflare cache non-static content that are cacheable for short period of time
    if (resp.http.Cache-Control !~ "private" && req.url !~ "^/(media|static)/" && obj.ttl > 0s && !obj.uncacheable) {
{{if enable_bfcache}}
        set resp.http.Cache-Control = "must-revalidate, max-age=60";
{{else}}
        set resp.http.Cache-Control = "no-store, must-revalidate, max-age=60";
{{/if}}
    }

    # Remove all headers that don't provide any value for the client
{{if use_xkey_vmod}}
    unset resp.http.XKey;
{{/if}}
    unset resp.http.Expires;
    unset resp.http.Pragma;
    unset resp.http.X-Magento-Debug;
    unset resp.http.X-Magento-Tags;
    unset resp.http.X-Powered-By;
    unset resp.http.Server;
    unset resp.http.X-Varnish;
    unset resp.http.Via;
    unset resp.http.Link;
}

sub vcl_synth {
    if(req.method == "PURGE")  {
        set resp.http.Content-Type = "application/json";
        if(req.http.X-Magento-Tags-Pattern) {
            set resp.body = {"{ "invalidated": "} + resp.reason + {" }"};
        } else {
            set resp.body = {"{ "invalidated": 1 }"};
        }
        set resp.reason = "OK";
        return(deliver);
    }
}
