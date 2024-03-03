#!/bin/sh
#
# Library for logging functions
#
# This is taken and adapted from bitnamis awesome logging utils
# https://github.com/bitnami/bitnami-docker-mysql/blob/master/8.0/debian-10/prebuildfs/opt/bitnami/scripts/liblog.sh
#
# We've /bin/sh'd it and added some other func
#

# Constants
RESET='\033[0m'
RED='\033[38;5;1m'
GREEN='\033[38;5;2m'
YELLOW='\033[38;5;3m'
MAGENTA='\033[38;5;5m'
CYAN='\033[38;5;6m'
LANDO_QUIET="${LANDO_QUIET:-no}"

# Functions

########################
# Print to STDERR
# Arguments:
#   Message to print
# Returns:
#   None
#########################
_lando_stderr_print() {
  # comparison is performed without regard to the case of alphabetic characters
  if [ $LANDO_QUIET = "no" ]; then
    printf "%b\\n" "${*}" >&2
  fi
}

# Functions

########################
# Print to STDERR
# Arguments:
#   Message to print
# Returns:
#   None
#########################
_lando_stdout_print() {
  printf "%b\\n" "${*}" >&1
}

########################
# Print messages
# Arguments:
#   Message to log
# Returns:
#   None
#########################
lando_blue() {
  _lando_stdout_print "${CYAN}${*}${RESET}"
}
lando_green() {
  _lando_stdout_print "${GREEN}${*}${RESET}"
}
lando_pink() {
  _lando_stdout_print "${MAGENTA}${*}${RESET}"
}
lando_yellow() {
  _lando_stdout_print "${YELLOW}${*}${RESET}"
}
lando_red() {
  _lando_stdout_print "${RED}${*}${RESET}"
}
lando_check() {
  _lando_stdout_print "${GREEN}✔ ${RESET}${*}"
}

########################
# Log message
# Arguments:
#   Message to log
# Returns:
#   None
#########################
_lando_log() {
  _lando_stderr_print "${GREEN}${LANDO_MODULE:-lando} ${MAGENTA}$(date "+%T.%2N ")${RESET}${*}"
}
########################
# Log an 'info' message
# Arguments:
#   Message to log
# Returns:
#   None
#########################
lando_info() {
  _lando_log "${GREEN}INFO ${RESET} ==> ${*}"
}
########################
# Log message
# Arguments:
#   Message to log
# Returns:
#   None
#########################
lando_warn() {
  _lando_log "${YELLOW}WARN ${RESET} ==> ${*}"
}
########################
# Log an 'error' message
# Arguments:
#   Message to log
# Returns:
#   None
#########################
lando_error() {
  _lando_log "${RED}ERROR${RESET} ==> ${*}"
}
########################
# Log a 'debug' message
# Globals:
#   BITNAMI_DEBUG
# Arguments:
#   None
# Returns:
#   None
#########################
lando_debug() {
  _lando_log "${MAGENTA}DEBUG${RESET} ==> ${*}"
}
