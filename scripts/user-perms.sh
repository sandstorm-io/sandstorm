#!/bin/sh

# Set defaults
: ${SILENT:=$1}

# Echo helper to recognize silence
if [ "$SILENT" = "--silent" ]; then
  LANDO_QUIET="yes"
fi

# Source da helpas
. /helpers/user-perm-helpers.sh
. /helpers/log.sh

# Set the module
LANDO_MODULE="userperms"

# Bail if we are not root
if [ $(id -u) != 0 ]; then
  lando_warn "Only the root user can reset permissions! This is probably ok though..."
  exit 0
fi

# Set defaults
: ${LANDO_WEBROOT_USER:=file-builder}
: ${LANDO_WEBROOT_GROUP:=file-builder}
: ${LANDO_WEBROOT_UID:=$(id -u $LANDO_WEBROOT_USER 2>/dev/null)}
: ${LANDO_WEBROOT_GID:=$(id -g $LANDO_WEBROOT_GROUP 2>/dev/null)}
: ${LANDO_ADDUSER_EXTRAS:='-M -N'}

# Get the linux flavor
if [ -f /etc/os-release ]; then
  . /etc/os-release
  : ${FLAVOR:=$ID_LIKE}
  : ${FLAVOR:=$ID}
elif [ -f /etc/arch-release ]; then
  FLAVOR="arch"
elif [ -f /etc/debian_version ]; then
  FLAVOR="debian"
elif [ -f /etc/fedora-release ]; then
  FLAVOR="fedora"
elif [ -f /etc/gentoo-release ]; then
  FLAVOR="gentoo"
elif [ -f /etc/redhat-release ]; then
  FLAVOR="redhat"
else
  FLAVOR="debian"
fi

# Make things

if [ ! -z ${LANDO_NO_USER_PERMS+x} ]; then
  lando_info "Skipping user perm sweep at because LANDO_NO_USER_PERMS is set"
  exit 0
fi

# Let's log some helpful things
lando_info "This is a $ID container"
lando_info "user-perms.sh kicking off as user $(id)"
lando_debug "Lando ENVVARS set at"
lando_debug ""
lando_debug "========================================"
lando_debug "LANDO_WEBROOT_USER      : $LANDO_WEBROOT_USER"
lando_debug "LANDO_WEBROOT_GROUP     : $LANDO_WEBROOT_GROUP"
lando_debug "LANDO_WEBROOT_UID       : $LANDO_WEBROOT_UID"
lando_debug "LANDO_WEBROOT_GID       : $LANDO_WEBROOT_GID"
lando_debug "LANDO_HOST_UID          : $LANDO_HOST_UID"
lando_debug "LANDO_HOST_GID          : $LANDO_HOST_GID"
lando_debug "========================================"
lando_debug ""

# Adding user if needed
lando_info "Making sure correct user:group ($LANDO_WEBROOT_USER:$LANDO_WEBROOT_GROUP) exists..."
add_user $LANDO_WEBROOT_USER $LANDO_WEBROOT_GROUP $LANDO_WEBROOT_UID $LANDO_WEBROOT_GID $FLAVOR "$LANDO_ADDUSER_EXTRAS"
verify_user $LANDO_WEBROOT_USER $LANDO_WEBROOT_GROUP $FLAVOR

# Correctly map users
# Lets do this regardless of OS now
lando_info "Remapping ownership to handle docker volume sharing..."
lando_info "Resetting $LANDO_WEBROOT_USER:$LANDO_WEBROOT_GROUP from $LANDO_WEBROOT_UID:$LANDO_WEBROOT_GID to $LANDO_HOST_UID:$LANDO_HOST_GID"
reset_user $LANDO_WEBROOT_USER $LANDO_WEBROOT_GROUP $LANDO_HOST_UID $LANDO_HOST_GID $FLAVOR
lando_info "$LANDO_WEBROOT_USER:$LANDO_WEBROOT_GROUP is now running as $(id $LANDO_WEBROOT_USER)!"

# Make sure we set the ownership of the mount and HOME when we start a service
lando_info "And here. we. go."
lando_info "Doing the permission sweep."
perm_sweep $LANDO_WEBROOT_USER $(getent group "$LANDO_HOST_GID" | cut -d: -f1) $LANDO_RESET_DIR
