# Sandstorm Security Non-events

This page lists security vulnerabilities which Sandstorm mitigated, such that Sandstorm users were never vulnerable to the bug&mdash;even before it was fixed.

Most of the bugs listed below are publicly-disclosed security vulnerabilities against apps which have Sandstorm ports. Of course, the disclosures were made against the non-Sandstorm version of the app. On Sandstorm, these bugs either didn't matter at all, or their impact was drastically reduced.

We also list some bugs below reported against the Linux kernel. These are bugs that normally would allow any process executing on a Linux machine to gain full control of the machine. Under a naive containerization environment, these bugs might allow an app to escape its container. However, Sandstorm's hardened sandbox protected against these vulnerabilities.

## Background

A few notes, to be sure we are on the same page.

* Security is risk-management, not binary. No software, Sandstorm included, will ever protect all user data from all bugs in all programs. But, raising barriers to a successful attack means fewer successful attacks will occur, which is obviously valuable. Sandstorm aims to reduce the risk of attack by an order of magnitude or more.
* Most real-world attacks do not involve novel new techniques or genius insights. Instead, attackers exploit the sad reality that most developers simply don't think carefully about their code. Developers often concern themselves primarily with making their code work in the common case; few developers ask themselves: "What is every possible path this code could take?" As a result, most apps are simply full of security bugs, and anyone looking for bugs in a particular app will find many in short order. Sandstorm therefore aims to (1) mitigate common app bugs, and (2) confine the damage caused by bugs it can't mitigate.
* Sandstorm does NOT operate like a traditional "web application firewall". Typical WAFs monitor for and block known attacks and suspicious behavior. Sandstorm uses fine-grained containerization and access control to create an environment where attacks are not effective in the first place, thus mitigating vulnerabilities across the board, including vulnerabilities that haven't been discovered yet. See [how Sandstorm works](https://sandstorm.io/how-it-works) and [Sandstorm's security practices](security-practices) for details.
* Of course, Sandstorm itself could be buggy. Sandstorm is written by security nerds&mdash;the kind of people who do ask themselves "What is every possible path this code could take?" Moreover, we plan to commission an outside security review before version 1.0. Hopefully, the chance of bugs in Sandstorm is less than the chance of bugs in an average app (and much less than the chance of bugs across *all* your apps). Nevertheless, Sandstorm _will_ have security vulnerabilities of its own at some point. Thankfully, Sandstorm's auto-updater ensures that all servers worldwide are updated within 24 hours of any new release, making the window of exploitability small for responsibly-disclosed bugs.
* The list below is not even remotely complete. Rather, it is a sample of the few bugs we've actually researched&mdash;from the few apps that are big enough to have attracted security review and publicly disclosed vulnerabilities. In all likelihood, the bugs that _haven't_ been reported far outnumber those that have. Luckily, since Sandstorm's approach does not target specific bugs, it likely mitigates unknown bugs just as well as it does known ones.

## Etherpad

On Sandstorm, every Etherpad instance hosts only a single document. Only users with whom that document has been shared (with at least read access) are able to interact with the Etherpad instance in any way. Therefore, it is nearly impossible for Etherpad to have a significant security issue on Sandstorm: in order to exploit the issue against a particular document, you would already have to have access to that document, probably making the attack moot.

Bugs mitigated:

* [CVE-2015-3297](http://www.openwall.com/lists/oss-security/2015/04/12/1), [4085](http://www.openwall.com/lists/oss-security/2015/05/26/3): Path injection bugs could allow remotely dumping arbitrary files from the server's filesystem, including the Etherpad database, leaking pad contents and user credentials (session tokens). On Sandstorm, Etherpad can only see its own package contents and database, not files belonging to other apps or the system, so it can only leak its own data. The main damage from that&mdash;leaking pad contents&mdash;doesn't matter on Sandstorm because to launch the attack the attacker would need read access already (as described above). Meanwhile, leaking session tokens could normally (outside Sandstorm) allow impersonation of other users, but on Sandstorm Etherpad relies on Sandstorm for authentication, and only uses session tokens to disambiguate anonymous users. Thus, on Sandstorm, this bug could be exploited to allow one user with edit access to impersonate some other anonymous user (forging edit history), but not to impersonate a logged-in user.

* [CVE-2015-2298](http://www.openwall.com/lists/oss-security/2015/03/15/3): Due to a malformed database query, a request to export a pad by ID would in fact return contents of all pads on the server which had the specified ID as a substring of their own. Thus, all pads on the server could be dumped by specifying a series of one-character IDs (or maybe in a single query with an empty ID). This bug is irrelevant on Sandstorm because the attacker would need already to have read access to launch the attack (as described above).

Bugs *not* mitigated:

* **We aren't aware of any.** In theory, though, a bug which specifically allows a user with ostensibly read-only access to a particular pad to perform edits on the pad would likely be equally exploitable on Sandstorm. However, the attacker would first have to have legitimate read access before they could perform any attack.

## WordPress

The WordPress app on Sandstorm is used to publish public web sites. However, the app does not respond to individual page views of that site. Instead, the app generates static content which it hands off to Sandstorm, and Sandstorm serves the site statically. The site administrator accesses WordPress's administrative interface through Sandstorm like any other app, but visitors to the public site visit a separate hostname where they don't see Sandstorm at all. The site owner may share access to the edit UI but would never share this access publicly.

As a result of this model, there is no way to exploit a bug in WordPress on Sandstorm if you only have access to the published site, because there is no way for you to cause any WordPress code to execute at all. The site owner must explicitly share access to the admin interface with you before you can interact with the app.

Additionally, because the WordPress admin interface is served through Sandstorm [on a random, unguessable hostname](security-practices.md#client-sandboxing), CSRF attacks are far more difficult to carry out against this interface. (They are not impossible, but they require a passive MITM of network traffic or other information leaks to carry out.)

This model has a downside: comments are currently not supported. However, with some engineering effort, comments could be re-enabled while maintaining strong security. To accomplish this, the public-facing web site would use client-side Javascript to communicate with an HTTP API exported by the Sandstorm app whenever a user posts a comment. In order to prevent vulnerabilities in the comment-handling code from threatening core site administration, comments could be managed by a separate app that runs in a separate grain (container) from the core site. With the right design, there is no need for information about comments to flow into the core site management, so vulnerabilities in the comment infrastructure would at worst allow an attacker to deface other users' comments, not the whole web site.

[WordPress has reported many vulnerabilities](http://www.cvedetails.com/vulnerability-list/vendor_id-2337/product_id-4096/). Below, we cover all WordPress CVEs scored with a severity of 6 or more in 2014 and 2015.

Bugs mitigated:

* [CVE-2015-5731](http://www.cvedetails.com/cve/CVE-2015-5731/): A CSRF vulnerability allows exercising admin's ability to lock posts. Sandstorm provides additional CSRF protection as described above.
* [CVE-2015-2213](http://www.cvedetails.com/cve/CVE-2015-2213/): XSS in comments. WordPress on Sandstorm currently does not support comments, but see the discussion of comments above.
* [CVE-2015-9038](http://www.cvedetails.com/cve/CVE-2014-9038/): Unauthenticated attacker can cause the WordPress server to make HTTP requests back to itself which may be given more authority than remote requests would. On Sandstorm, only editors/admins would be able to exploit the vulnerability.
* [CVE-2015-9037](http://www.cvedetails.com/cve/CVE-2014-9037/): Bug in authentication code could allow hijacking long-dormant accounts that used an older password hash algorithm. Sandstorm unaffected because WordPress on Sandstorm relies on Sandstorm for authentication.
* [CVE-2014-9033](http://www.cvedetails.com/cve/CVE-2014-9033/): CSRF in password reset flow. WordPress on Sandstorm not vulnerable because it relies on Sandstorm for authentication and does not implement its own passwords.
* [CVE-2014-5205](http://www.cvedetails.com/cve/CVE-2014-5205/), [5204](http://www.cvedetails.com/cve/CVE-2014-5204/): Possible bypass of CSRF protections. Sandstorm adds additional protection by putting the admin interface on a randomized hostname.
* [CVE-2014-5203](http://www.cvedetails.com/cve/CVE-2014-5203/): Unauthenticated attacker can cause arbitrary code execution via malicious serialized data. On Sandstorm, only editors/admins could exploit this.
* [CVE-2014-0166](http://www.cvedetails.com/cve/CVE-2014-0166/): Possible to forge authentication cookies. WordPress on Sandstorm not vulnerable because it relies on Sandstorm (not cookies) for authentication.

Bugs *not* mitigated:

* **We aren't aware of any.** However, as stated above, we only examined bugs with severity score 6 or higher in 2014 and 2015.

## Roundcube

When using Roundcube for email on Sandstorm, each user's mailbox lives in a unique grain of the app. This is by contrast with standard Roundcube, where a central install serves multiple users.

Bugs mitigated:

* [CVE-2014-9587](https://www.cvedetails.com/cve/CVE-2014-9587/): Multiple CSRF vulnerabities. Sandstorm provides additional CSRF protection (see WordPress section, above).
* [CVE-2015-5381](https://security-tracker.debian.org/tracker/CVE-2015-5381): Reflected cross-site scripting. Sandstorm mitigates reflected-XSS attacks in much the same way it mitigates CSRF attacks: the attacker would have to know the app's randomly-generated hostname for the attack to work. An attacker with passive network MITM abilities or some other way of obtaining the hostname might be able to carry out an attack, but this is a much higher bar than outside of Sandstorm.
* [CVE-2015-5382](https://security-tracker.debian.org/tracker/CVE-2015-5382): Reading arbitrary files on the filesystem. Much like with similar Etherpad issues, this is irrelevant on Sandstorm because each Roundcube mailbox runs as a separate instance of the app in an isolated container, these instances cannot see each other's files, and there is no way to send requests to a particular mailbox instance unless the owner has explicitly shared access with you.
* [CVE-2015-5385](https://security-tracker.debian.org/tracker/CVE-2015-5383): Log data leakage. Irrelevant on Sandstorm because each Roundcube mailbox has a separate log file visible only to it.

Bugs *not* mitigated:

* [CVE-2015-1433](https://www.cvedetails.com/cve/CVE-2015-1433/): An XSS delivered via email (not reflected). This could allow an attacker to gain control of a victim's mailbox by emailing them. Note that, while this is still a serious exploit under Sandstorm, it is less serious than outside Sandstorm for several reasons: Barring additional exploits, the attacker would only gain control of the grain's iframe in the victim's browser from the point when the victim opens the email until the point when they close the grain tab. No long-term authentication credentials would be visible to the attack script, as they are managed by Sandstorm outside of the app. This access cannot be extended by e.g. installing a ServiceWorker because Sandstorm uses a different randomly-generated hostname every time the grain is opened; previous hostnames expire shortly after being closed. Moreover, the attacker would **not** gain any control over the Sandstorm UI, and thus would **not** be able to modify the access control on the grain to give themselves long-term access. That said, a single attack would likely be sufficient to exfiltrate all of the user's recent mail, which is obviously serious. In the future, when Sandstorm's client-side sandbox is hardened to apply [full confinement](security-practices.md#true-confinement), this exfiltration will be harder since the attack script would not be able to contact its home server from the client browser. The attack script would presumably still be able to exfiltrate information by sending emails, though this is likely more detectable.

## ShareLaTeX

When using ShareLaTeX on Sandstorm, each LaTeX document lives in a separate grain. The situation is much the same as Etherpad: it is difficult to imagine a ShareLaTeX vulnerability that would have more than trivial impact on Sandstorm.

Bugs mitigated:

* [CVE-2015-0933](http://www.cvedetails.com/cve/CVE-2015-0933): Users can download arbitrary files from the server through a crafted document. Outside Sandstorm this could allow reading all users' documents, but on Sandstorm each document lives in a separate grain, therefore the attacker could only read files from the grain of the document they attacked. The attacker must already have write access to the document in order to attack it, therefore the attack is worthless.
* [CVE-2015-0934](http://www.cvedetails.com/cve/CVE-2015-0934): An attacker can run arbitrary shell commands by creating files whose names contain backtick characters. On Sandstorm, since every document lives in a separate grain, the attacker would only be able to gain control of individual documents to which they already have write access, making the attack mostly worthless.

Bugs *not* mitigated:

* **We aren't aware of any.** In theory, the situation is similar to Etherpad.

## Tiny Tiny RSS

When using Tiny Tiny RSS in Sandstorm, every user's feed lives in a unique grain.

Bugs mitigated:

* [2016-02-15 (No CVE number)](http://seclists.org/fulldisclosure/2016/Feb/73): SQL injection vulnerability allows a user to take control of a TTRSS server. On Sandstorm, this bug is irrelevant, since each user's feed is a separate instance, so if the user has access to the TTRSS server at all, they already have full control over it.

Bugs *not* mitigated:

* **We aren't aware of any.** However, Tiny Tiny RSS does not have a well-organized security advisory list. In theory, Tiny Tiny RSS could be vulnerable to XSS attacks embedded in malicious feeds. A Sandstorm user concerned about such attacks might consider running multiple instances of Tiny Tiny RSS to separate untrustworthy feeds from sensitive feeds, so that an attack from an untrustworthy feed cannot get access to a sensitive feed.

## Linux kernel

The Linux kernel has had many bugs that could allow any local process to gain root privileges or otherwise bypass security rules. Sandstorm blocks most of these vulnerabilities by virtue of its [server-side sandbox](security-practices.md#server-sandboxing) which disables much of the Linux kernel API thereby reducing the surface of attack only to core, well-reviewed functionality.

Bugs mitigated:

* [CVE-2013-1956](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2013-1956), [1957](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2013-1957), [1958](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2013-1958), [1959](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2013-1959), [1979](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2013-1979), [CVE-2014-4014](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-4014), [5206](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-5206), [5207](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-5207), [7970](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-7970), [7975](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-7975), [CVE-2015-2925](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-2925), [8543](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-8543), [CVE-2016-3134](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2016-3134), [3135](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2016-3135), etc.: The introduction of unprivileged user namespaces lead to a huge increase in the attack surface available to unprivileged users by giving such users legitimate access to previously root-only system calls like `mount()`. All of these CVEs are examples of security vulnerabilities due to introduction of user namespaces. Under some configurations, Sandstorm uses user namespaces to set up its own sandbox; under all configurations, it disallows the sandboxed app from creating its own namespaces, rendering these vulnerabilities unexploitable.
* [CVE-2014-0181](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-0181), [CVE-2015-3339](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-3339): These are bugs that require the presence of a setuid binary. Sandstorm disables setuid binaries inside the sandbox via the `NO_NEW_PRIVS` process flag and other mechanisms.
* [CVE-2014-4699](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-4699): A bug in `ptrace()` could allow privilege escalation. Sandstorm disables `ptrace()` inside the sandbox using seccomp.
* [CVE-2014-9529](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-9529): A series of crafted `keyctl()` calls could cause kernel DoS / memory corruption. Sandstorm disables `keyctl()` inside the sandbox using seccomp.
* [CVE-2015-3290](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-3290), [5157](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-5157): Bugs in the kernel's non-maskable interrupt handling allowed privilege escalation. Can't be exploited on Sandstorm because the `modify_ldt()` system call is blocked using seccomp.
* [CVE-2015-3214](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-3214), [4036](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2015-4036): These are bugs in common virtualization drivers which could allow a guest OS user to execute code on the host OS. Exploiting them requires access to virtualization devices in the guest. Sandstorm hides direct access to these devices. Interestingly, these seem to be cases where Sandstorm's sandbox is "more secure" than a VM, going against common wisdom that VMs are "more secure" than containers.
* [CVE-2016-0728](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2016-0728): Use-after-free caused by crafted `keyctl()` calls could lead to privilege escalation. Sandstorm disables `keyctl()` inside the sandbox using seccomp.
* [CVE-2016-2383](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2016-2383): A bug it eBPF -- the special in-kernel DSL used to express things like seccomp filters -- allowed arbitrary reads of kernel memory. The `bpf()` system call as well as the ability to set seccomp filters are blocked inside Sandstorm using (ironically) seccomp.

Bugs *not* mitigated:

* [CVE-2014-9090](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-9090), [9322](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2014-9322): AKA "BadIRET". According to Andy Lutomirski, who discovered and fixed the bug (and who wrote Sandstorm's seccomp filter): "Very hard to exploit from inside Sandstorm, but it just might have been possible using a bizarre vector. Certainly the standard exploit would not work."
* [CVE-2016-2069](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2016-2069): A subtle race condition between CPU cores which could allow a process to execute briefly with a stale TLB state, possibly allowing it to corrupt memory it doesn't own. It is unknown whether this bug is actually exploitable in practice. Andy, who discovered and fixed this bug too, suspects it would be very difficult even to observe the race, much less exploit it.
