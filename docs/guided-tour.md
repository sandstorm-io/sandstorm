# Guided tour of Sandstorm, including install

Format: Self-driven hands-on tutorial

If you have 15 minutes and want to learn more about Sandstorm, enjoy this hands-on tour. After you work through it, you will:

* Understand how installing apps and creating documents/instances works in Sandstorm.
* Understand how app instance sharing works in Sandstorm.
* Understand the current limits of Sandstorm, and where the project is headed in the future.
* (If desired) have a free-of-cost virtual machine, hosted by Amazon, to run Sandstorm on for a year, or at DigitalOcean with a coupon code.

## Optional: Install Sandstorm

You can proceed through this tutorial using the [Sandstorm demo server](https://demo.sandstorm.io/) at https://demo.sandstorm.io. By default, we will have you do that.

If you wish, you could take the time now to install Sandstorm on a Linux server of your own. Amazon offers a free-of-cost one year trial where you can use their hosting services for free. To do that, keep reading.

If you don't want to install Sandstorm right now, skip to the **Hands on tour** section.

### Create a virtual machine in Amazon EC2

Amazon's EC2 service is oriented toward software developers and system administrators, and so its control panel is filled with options. This section explains what you need to know to create a new virtual Linux server hosted by Amazon EC2 to run Sandstorm.

To set that up, follow this [excellent tutorial](http://www.canopy.link/dz/launch_ec2_instance.html). After you've done that, you should be able to:

* See your virtual machine in Amazon's EC2 web console, and
* Log in to it remotely over SSH.

If so, proceed to the next section.

### Configure the EC2 security groups (firewall) to let you reach Sandstorm

By default, Amazon EC2 protects your virtual machine from being reached over the Internet.

In the above tutorial, we allow the virtual machine to be reached on **port 80**. By default, Sandstorm uses **port 6080**, so look through the above tutorial and add another _security groups_ rule allowing port 6080.

### SSH in, and run the Sandstorm install script

Follow the instructions at [https://sandstorm.io/install/](https://sandstorm.io/install/).

I personally recommend using the Google login provider, but naturally you can choose any you like.

Sandstorm comes with a dynamic DNS service for free, so you once you install Sandstorm, your server will be online at a name like _http://garply.sandcats.io:6080/_.

### Proceed with the guided tour

Now that your server is online, and has a name, you can use it in the rest of this guided tour instead of the demo server.

## Hands-on tour

During this tutorial, you're going to try out some cool features of Sandstorm. You can try them out using the Sandstorm demo server at [https://demo.sandstorm.io/](https://demo.sandstorm.io/).

**Note: demo data is temporary.** Accounts on the Sandstorm demo server expire after one hour! By contrast, when you run Sandstorm yourself, you keep your data for as long as you like.

### Like Google Apps, but open source and on your own server

One of the common reasons to use Sandstorm is to have online collaboration software that runs on your own server.

Etherpad is a real-time text editor that demonstrates how to use Sandstorm that way. Make sure you're logged into Sandstorm (if using the demo, click **Start the demo**). Then click:

* **Install apps** - this takes you to the Sandstorm app list. (Soon to be the Sandstorm App Marketplace!)
* Click the **Install** button next to _Etherpad_. (Sandstorm may ask you for confirmation.)
* Click **New Etherpad Document** button on your Sandstorm.

You're now in an Etherpad document. Installing Etherpad allows you to create as many Etherpad documents as you want.

If you want to create spreadsheets on your server, consider installing _Ethercalc_.

If you want to edit scientific documents, consider installing _ShareLaTeX_.

If you want to create presentations, consider installing _Hacker Slides_.

Each document is an _instance_of that app, with Sandstorm isolating each one from each other.

### Sharing

In Sandstorm, each app instance is private by default. In order to collaborate, you create a _sharing link_.

In your Etherpad document, look for the blue **Share** link at the top (or the side) of the document. Click it, choose a permission level, and click **create**.

When you give this link to someone, they will be able to participate in the document with you.

To read more about sharing in Sandstorm, read [Delegation is the cornerstone of civilization](https://blog.sandstorm.io/news/2015-05-05-delegation-is-the-cornerstone-of-civilization.html).

### Static publishing

Sandstorm supports a number of publishing apps, including WordPress and Ghost. (The [Sandstorm blog](https://blog.sandstorm.io/) is hosted on our own Sandstorm instance using a custom app called Hacker CMS.)

Try them out!

* Click the **Sandstorm** logo in the top-left, and
* Click **Install apps** and
* Find _WordPress_ or _Ghost_ on the page, and click **Install*.
* Click **New WordPress site** (or similar for Ghost).

This takes you to WordPress running on your server. You are automatically logged-in and can start writing. You can click **Rebuild public site** and this snapshots your blog as static HTML and exports it at a random hostname.

You can also configure a custom domain to map to the same static content. Only people with whom you **share** the WordPress instance can interact with WordPress's PHP code. The result is that WordPress becomes a security-hardened collaborative static site generator.

### Ask questions

This brings us to the end of our tour. Ask questions! Also give me feedback on how to improve this tour.