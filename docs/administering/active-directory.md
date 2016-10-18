This document explains how to integrate with Microsoft Active Directory (also known as AD).  This
allows all users, or specific users within your Windows domain, to log into a Sandstorm server. The
integration requires [Sandstorm for Work.](for-work.md)

## AD & Sandstorm: Overview

Sandstorm can rely on AD to authenticate users.

ActiveDirectory exists as a cloud product called Windows Azure as well as a software product called
Windows Server. Sandstorm supports both products.

Sandstorm can be configured to use single sign-on in a configuration where Sandstorm never sees the
user's passwords. This relies on Sandstorm's support for SAML 2.0.

This document provides textual advice as well as a great deal of screenshots to allow you to proceed
with confidence. If you have questions, please email support@sandstorm.io. We want to help you
successfully set up Sandstorm!

Note that you can also set up Sandstorm to integrate with Active Directory using LDAP bind to
authenticate users. We recommend Active Directory Federation Services or Microsoft Azure AD Single
Sign-On instead, which use SAML. SAML has the advantage that user never type passwords into
Sandstorm. If you must use LDAP instead, see the general [Sandstorm for Work documentation about
LDAP](for-work.md#authentication-provider-ldap) or email support@sandstorm.io.

## Windows Azure Active Directory

**Summary:** Once you have created a directory, you must add a new **application from the gallery,**
configure Sandstorm as a **custom app,** then enable **Microsoft Azure AD Single Sign-On.** This
process will involve Azure AD creating a SAML provider entry point URL and a custom SAML
certificate. Once you have done this, you can use Active Directory to choose which users in your
domain are allowed to use Sandstorm.

Here is a screenshot tour, using example.sandcats.io as an example Sandstorm server.

These instructions use the Classic Azure Active Directory portal found at
[manage.windowsazure.com.](https://manage.windowsazure.com) If you are using the new portal at
portal.azure.com, please click on "classic portal" or browse to manage.windowsazure.com in order to
follow these instructions.

- Go to: manage.windowsazure.com

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/01.png)

- Click "Active Directory" in the sidebar.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/02.png)

- Choose the directory you wish to use to sign into Sandstorm.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/03.png)

- Click "Applications" in the top bar.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/04.png)

- Choose "Add" from the bottom bar (NOT "+ New").

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/05.png)

- Choose "Add an application from the gallery"

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/07.png)

- Choose "custom" from the sidebar. Choose "Add an unlisted application my organization is using".

    - If this option is not displayed: Make sure you are using the classic portal. This option does not yet appear in the new portal. This option may require upgrading to Azure AD Premium.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/08.png)

- Enter name: "Sandstorm". Click the checkmark in the lower-right.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/09.png)

- Choose "Configure single sign-on"

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/10.png)

- Choose "Microsoft Azure AD Single Sign-On". Click the "next" arrow.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/11.png)

- Now, visit your Sandstorm server and begin configuring SAML login. In the Sandstorm SAML config, make sure your "Entity ID" is the full URL to your Sandstorm server, including the leading "https://", which you will also use as the Azure AD "Identifier". Azure AD requires that the entity ID be a full URL, not a hostname. You will also need to copy the Sandstorm server's Service URL to your clipboard.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/13-blanked.png)

- Return to the Microsoft Azure AD page in your web browser. For "Identifier", enter the Sandstorm server's URL. (Example: "https://example.sandcats.io") For "Reply URL", enter the Sandstorm server's Service URL from the Sandstorm SAML config. (Example: "https://example.sandcats.io/_saml/validate/default"). Click the "next" arrow.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/12.png)

- Click "Download Certificate (Base 64 - most common)".

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/14.png)

- Open the certificate file in a text editor (such as Notepad).

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/15.png)

- Copy/paste the contents of the file into Sandstorm's SAML login configuration under "SAML cert for above provider:".

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/13.png)

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/16.png)

- Back in the Azure AD configuration, copy the line titled "Single Sign-On Service URL". In the Sandstorm config, paste this under "SAML provider entry point URL:".

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/17.png)

- In the Azure AD config, check the box: "Confirm that you have configured single sign-on as
  described above." Clik the "next" arrow and enter your email address for service alerts from
  Microsoft. Click the checkbox to complete configuration.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/18.png)

- Click the checkbox to complete configuration.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/19.png)

- Click: "Users and Groups", then "All Users". Click the check-mark to request Sandstorm access for
  all users. Note that Sandstorm only counts a user for billing purposes if they actually log into
  Sandstorm during a particular month.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/22.png)

- The system will ask you if you are sure. Click "Yes" to confirm.

![Screenshot of this step](https://alpha-evgl4wnivwih0k6mzxt3.sandstorm.io/azure-ad-config/23.png)

**Congratulations!** You have enabled Sandstorm for all the users in your Microsoft Azure Active Directory service.

<!--
## Windows Server Active Directory

**Summary:** Once you have created a directory, you must use ActiveDirectory Federation Services to
add a new Relying Party, namely the Sandstorm web application. Each Sandstorm server publishes
federation metadata information at a URL available within the SAML configuration page.  You must
configure a rule that sends user email address to Sandstorm, as well as a rule that declares email
addresses are the persistent identifier. You must also export the custom SAML certificate to
Sandstorm.  Once you have done this, you can use Active Directory to choose which users in your
domain are allowed to use Sandstorm.

Here is a screenshot tour, using example.sandcats.io as an example Sandstorm server.
-->
