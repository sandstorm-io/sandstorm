# Backups

You can manually perform backups of Sandstorm data via the web interface and/or via the command line.
In the long run, we'd like to enable automated backups as well.

## To back up one individual grain

If you're the owner of a grain on Sandstorm, you can back up an individual grain by clicking the
download icon in the [top bar](../using/top-bar.md). This will give you a ZIP file of the grain's
contents. This contains the full writable state of the app, so you can restore it to any Sandstorm
server.

If you want to get crafty, you can modify a backup to point to a different app ID, allowing you to
migrate data between apps, or use your data with an experimental app with a different app ID. You
can also change the contents of the backup before restoring it. To ensure Sandstorm accepts the modified backup please follow these steps:
- Backup the grain and download the zip file
- unpack the zip file
- to edit the app id
  - create your new Sandstorm package (see https://github.com/sandstorm-io/vagrant-spk)
  - open one new grain and download the backup
  - unzip the backup and copy the whole `metadata` file (this binary file includes the app id)
  - unzip also the backup of the grain where you want to change the app id
  - paste the previously copied `metadata` file
- To change any app specific content go to the data folder and you'll find the writable part of the grains folder structure
- zip the whole folder with the command line zip tool: `zip -ry myapp.zip .` (at least the macOS onboard tool does not produce usable zip files for Sandstorm)
- upload the manually packed backup file to the server where you are running the app

In this way, Sandstorm gives every app a fully-functional import/export system.

## To back up the entire Sandstorm server

Sandstorm stores all its data in `/opt/sandstorm`, plus two symbolic links in `/usr/local/bin`, plus
a service file for systemd or sysvinit.

If you run your own Sandstorm server, you can back up the entire Sandstorm installation safely by
stopping the service:

    sudo sandstorm stop
    sudo service sandstorm stop

and taking a filesystem snapshot of `/opt/sandstorm`. If your filesystem doesn't support online
snapshots you can make a quick backup by running:

    cp -a /opt/sandstorm $HOME/sandstorm-snapshot-from-$(date -I)

Alternatively, one can make a backup using tar.

    tar -cf $HOME/sandstorm-snapshot-from-$(date -I).tar /opt/sandstorm

Then restart Sandstorm to end the interruption:

    sudo service sandstorm start

This guide uses `$(date -I)`, which is a way to embed the current date into a filename, in a format
such as `2005-10-30`.

**Note about warnings from tar:** If you see errors involving socket files being ignored, you can
ignore those warnings. The `tar` utility might print messages like this:

```
/opt/sandstorm/var/sandstorm/grains/bdMmGkov6gpiSSXC9GHysy/socket: socket ignored
```

You should rely on tar's **exit code** being 0 to know if the tar command completed successfully.

### To restore a Sandstorm server backup

If you have a tar-based backup of `/opt/sandstorm`, the easiest way to restore it is to:

- Run the install script, and allow it to configure a systemd/sysvinit service.

- Stop the Sandstorm service, e.g. `sudo sandstorm stop`

- Move the `/opt/sandstorm` directory to `/opt/sandstorm.empty`

- Copy your backup into `/opt/sandstorm`

- Start the Sandstorm service, e.g. `sudo service sandstorm start`

- Visit your Sandstorm server and make sure everything still works.

- Remove the now-useless `/opt/sandstorm.empty` directory.

You can also use the [Docker container
documentation](../install.md#option-6-using-sandstorm-within-docker) to run your snapshot of
`/opt/sandstorm`. You will need to create a Docker volume with your backup of `/opt/sandstorm`, and
it will continue to execute until you stop the Docker container.
