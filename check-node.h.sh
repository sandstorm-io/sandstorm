
cat /etc/ca-certificates.conf

# Check if curl can handle TLS:
curl -v https://packages.meteor.com

# Patch logging to be more helpful.
find ~/.meteor -type f -name catalog.js -exec \
	sed -i -e 's|\"Unable to update package catalog |err, \"|' \{} \;

cd shell
meteor show --ejson METEOR@2.3.5
