## Self-hosted HTTPS with a custom certificate authority

Note: these instructions were written before Sandcats offered [free HTTPS](ssl.md).

The following is a process for self-hosted instances of Sandstorm to use SSL with sandcats.io DNS. These steps create a Certificate Authority (CA), corresponding CA Certificate, and the private and public keys for the `[anything].sandcats.io` and `*.[anything].sandcats.io` domains.

**Note**: Web browsers will display a big red certificate error when you try to connect to this install. This tutorial is appropriate if you are OK with reconfiguring web browsers to trust a custom certificate authority that you will create during this tutorial. For automatically-trusted SSL configuration, you will need to use a sandcats.io hostname or follow instructions from a certificate authority.

1. **Make a copy openssl.cnf:**

        cp /etc/ssl/openssl.cnf [directory_you_want_copy_to_be]


2. **Add the following to the end of the copied `openssl.cnf` file:**

        [req]
        req_extensions = v3_req

        [ v3_req ]

        # Extensions to add to a certificate request

        basicConstraints = CA:FALSE
        keyUsage = nonRepudiation, digitalSignature, keyEncipherment
        subjectAltName = @alt_names

        [alt_names]
        DNS.1 = [your-domain-name].sandcats.io
        DNS.2 = *.[your-domain-name].sandcats.io

3. **Create the Certificate Authority (CA) Key:**

        openssl genrsa -out rootCA.key 4096
    `rootCA.key` is the file for the Certificate Authority (CA) key.


4. **Sign the Certificate Authority (CA) Key and Create Certificate Authority (CA) certificate (Expires in 10 years):**

        openssl req -x509 -new -nodes -key rootCA.key -days 3650 -out rootCA.pem

    `rootCA.pem` is the file for the Certificate Authority (CA) certificate


5. **Create Sandstorm Device Private Key:**

        openssl genrsa -out sandstorm.key 4096

    `sandstorm.key` is the Sandstorm Device Private Key


6. **Create Sandstorm Device Certificate Signing Request (CSR) using the copied and edited openssl.cnf file:**

        openssl req -new -key sandstorm.key -out sandstorm.csr -config openssl.cnf

    `sandstorm.csr` is the Sandstorm Device Certificate Signing Request (CSR)


7. **Create and sign the Sandstorm Certificate (Expire in 2 years):**

        openssl x509 -req -in sandstorm.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial -out sandstorm.crt -days 730 -extensions v3_req -extfile openssl.cnf

    `sandstorm.crt` is the Sandstorm Certificate


8. **Import the Certificate Authority (CA) Certificate (`rootCA.pem`) into the browser's that will be using Sandstorm. Some browsers may load grains without this step and ask users to add a security excpetion in order to fully load grains.**

9. **Copy (FTP/SSH) the Sandstorm Certificate and Sandstorm Private Key to the nginx ssl directory, it may be `/etc/nginx/ssl`**.


10. **Change these lines in your nginx conf file to reflect the new Sandstorm Certificate and Private Key filenames**:

        ssl_certificate /etc/nginx/ssl/sandstorm.crt;
        ssl_certificate_key /etc/nginx/ssl/sandstorm.key;

11. **Restart nginx**:

        sudo service nginx restart

12. **Restart Sandstorm:**

        sudo sandstorm restart
    or

        sudo /opt/sandstorm/sandstorm restart


Created with help from:

* [https://docs.sandstorm.io/en/latest/administering/reverse-proxy/](reverse-proxy.md)
* [http://datacenteroverlords.com/2012/03/01/creating-your-own-ssl-certificate-authority/](http://datacenteroverlords.com/2012/03/01/creating-your-own-ssl-certificate-authority/)
* [https://wiki.cacert.org/FAQ/subjectAltName](https://wiki.cacert.org/FAQ/subjectAltName)
* [http://www.codeproject.com/Tips/833087/X-SSL-Certificates-With-Custom-Extensions](http://www.codeproject.com/Tips/833087/X-SSL-Certificates-With-Custom-Extensions)
* [http://markmail.org/message/grfu4qkr5v5xttc2](http://markmail.org/message/grfu4qkr5v5xttc2)
* [http://blog.loftninjas.org/2008/11/11/configuring-ssl-requests-with-subjectaltname-with-openssl/](http://blog.loftninjas.org/2008/11/11/configuring-ssl-requests-with-subjectaltname-with-openssl/)
