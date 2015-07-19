You can backup an individual grain by clicking the download backup
icon at the top of your sandstorm app. The entire sandstorm
installation can be backed up safely by stopping sandstorm:

    sudo service stop sandstorm

and taking a filesystem snapshot of `/opt/sandstorm`. If your
filesystem doesn't support online snapshots you can make a quick
backup by running:

    cp -a /opt/sandstorm [the destination of your backup]

Alternatively one can make a backup using tar

    tar -cf [location of tar archive] /opt/sandstorm

Then restart sandstorm to end the interruption:

    sudo service start sandstorm