#!/usr/bin/env perl
use strict;
use warnings;

my $input_file = $ARGV[0] || 'etc/varnish6.vcl';
my $output_file = $ARGV[1] || 'generated.vcl';

open(my $in, '<', $input_file) or die "Can't open $input_file: $!";
open(my $out, '>', $output_file) or die "Can't open $output_file: $!";

my %defaults = (
    'HOST' => $ENV{HOST} || $ENV{s1_addr},
    'PORT' => $ENV{PORT} || $ENV{s1_port},
    'GRACE_PERIOD' => '300',
    'SSL_OFFLOADED_HEADER' => 'X-Forwarded-Proto',
    'USE_XKEY_VMOD' => '1',
    'ENABLE_BFCACHE' => '1',
    'ENABLE_MEDIA_CACHE' => '1',
    'ENABLE_STATIC_CACHE' => '1',
    'ENABLE_404_CACHE' => '1',
    'ACCESS_LIST' => 'server1 server2',
    'SERVER1_IP' => $ENV{SERVER1_IP} || $ENV{s1_addr},
    'SERVER2_IP' => '10.0.0.2',
    'PASS_ON_COOKIE_PRESENCE' => 'cookie1 cookie2',
    'COOKIE1_REGEX' => '^ADMIN',
    'COOKIE2_REGEX' => '^PHPSESSID',
    'TRACKING_PARAMETERS' => 'utm_source|utm_medium|utm_campaign|gclid|cx|ie|cof|siteurl',
    'DESIGN_EXCEPTIONS_CODE' => 'if (req.url ~ "^/media/theme/") { hash_data("design1"); }'
);

# Set defaults only for missing environment variables
for my $key (keys %defaults) {
    $ENV{$key} = $defaults{$key} unless exists $ENV{$key};
}

my $content = do { local $/; <$in> };

# Handle if-else statements first
while ($content =~ /{{if\s+([^}]+)}}(.*?)(?:{{else}}(.*?))?{{\/if}}/gs) {
    my $condition = uc($1);
    my $if_block = $2;
    my $else_block = $3 // '';
    my $value = $ENV{$condition} || '';
    my $replacement = $value eq '1' ? $if_block : $else_block;
    $content =~ s/{{if\s+([^}]+)}}(.*?)(?:{{else}}(.*?))?{{\/if}}/$replacement/s;
}

# Handle for loops with specific context
$content =~ s/{{for\s+item\s+in\s+([^}]+)}}(.*?){{\/for}}/handle_for($1, $2)/egs;

# Handle remaining variables
while ($content =~ /{{var\s+([^}]+)}}/) {
    my $var_name = uc($1);
    my $value = defined $ENV{$var_name} ? $ENV{$var_name} : '';
    $content =~ s/{{var\s+$1}}/$value/g;
}

print $out $content;
close($in);
close($out);

sub handle_for {
    my ($list_name, $template) = @_;
    my $list_var = uc($list_name);
    my $items = $ENV{$list_var} || '';
    my $output = '';

    foreach my $item (split(/\s+/, $items)) {
        my $item_content = $template;

        # Keep track of original item name for property lookups
        my $original_item = $item;

        # Handle simple item replacements
        $item_content =~ s/{{var\s+item}}/$item/g;

        # Handle item properties with original item name
        while ($item_content =~ /{{var\s+item\.([^}]+)}}/) {
            my $prop = $1;
            my $prop_var = uc("${original_item}_${prop}");
            my $prop_value = $ENV{$prop_var} || '';
            $item_content =~ s/{{var\s+item\.$prop}}/$prop_value/g;
        }
        $output .= $item_content;
    }
    return $output;
}