from __future__ import (
    unicode_literals,
    print_function,
    absolute_import,
)
import argparse
import glob
import logging
import datetime
import os
import pexpect
import random
import re
import subprocess
import sys

def _run_capture_output(*args, **kwargs):
    kwargs = dict(kwargs)
    kwargs['stdout'] = subprocess.PIPE
    p = subprocess.Popen(*args, **kwargs)
    status = p.wait()
    output = p.communicate()[0]
    assert status == 0, ("subprocess failed: argv=%s, status=%d, output=%s" % (
        args, status, output))
    return output


def _expect(line, current_cmd, do_re_escape=True, do_detect_slow=True,
            strip_comments=True, verbose=True):
    timeout = 2

    slow_text_timeout = int(os.environ.get('SLOW_TEXT_TIMEOUT', 30))
    veryslow_text_timeout = 2 * slow_text_timeout

    if do_detect_slow:
        slow_token = '$[slow]'
        if line.startswith(slow_token):
            print('Slow line...')
            timeout = slow_text_timeout
            line = line.replace(slow_token, '', 1)

        veryslow_token = '$[veryslow]'
        if line.startswith(veryslow_token):
            print('Very slow line...')
            timeout = veryslow_text_timeout
            line = line.replace(veryslow_token, '', 1)

    if verbose:
        print('expecting', line)

    if do_re_escape:
        line = re.escape(line)

    current_cmd.expect(line, timeout=timeout)


TEST_ROOT = os.path.dirname(os.path.abspath(__file__))


def vagrant_destroy():
    _run_capture_output(['vagrant', 'destroy', '-f'], cwd=TEST_ROOT)


def handle_test_script(vagrant_box_name, lines):
    current_cmd = None

    for line in lines:
        # Figure out what we want to do, given this line.
        if line.startswith('$[run]'):
            arg = line.replace('$[run]', '')
            arg = 'vagrant ssh ' + vagrant_box_name + ' -c "' + arg + '"'
            print('$', arg)
            current_cmd = pexpect.spawn(arg, cwd=TEST_ROOT)
        elif '$[exitcode]' in line:
            left, right = map(lambda s: s.strip(), line.split('$[exitcode]'))
            # Expect end of file.
            current_cmd.expect(pexpect.EOF, timeout=1)
            current_cmd.close()
            assert current_cmd.exitstatus == int(right)

        elif '$[type]' in line:
            # First, we expect the left side.
            left, right = map(lambda s: s.strip(), line.split('$[type]'))
            _expect(left, current_cmd=current_cmd)

            if right == 'gensym':
                # instead of typing the literal string gensym, we generate
                # a hopefully unique collection of letters and numbers.
                right = ''.join(
                    random.sample('abcdefghijklmnopqrstuvwxyz0123456789', 10))

            # Then we sendline the right side.
            current_cmd.sendline(right)
        else:
            # For now, assume the action is expect.
            _expect(line, current_cmd=current_cmd)


def parse_test_file(headers_list):
    postconditions = []
    cleanups = []
    parsed_headers = {}

    for header in headers_list:
        key, value = map(lambda s: s.strip(), header.split(':'))
        key = key.lower()

        if key == 'vagrant-box':
            parsed_headers['vagrant-box'] = value

        if key == 'title':
            parsed_headers['title'] = value

        if key == 'vagrant-destroy-if-bash':
            if key not in parsed_headers:
                parsed_headers[key] = []
            parsed_headers[key].append(value)

        if key == 'vagrant-precondition-bash':
            if key not in parsed_headers:
                parsed_headers[key] = []
            parsed_headers[key].append(value)

        if key == 'postcondition':
            postconditions.append([key, value])

        if key == 'cleanup':
            cleanups.append([key, value])

    # Some keys are required.
    #
    # Also uh I should probably be using capnproto for this, hmm.
    for required_key in ['vagrant-box']:
        assert required_key in parsed_headers, "Missing %s" % (required_key,)

    return parsed_headers, postconditions, cleanups


def handle_headers(parsed_headers):
    vagrant_box_name = parsed_headers['vagrant-box']

    # Bring up VM, if needed.
    vagrant_up_or_resume(vagrant_box_name)

    values = parsed_headers.get('vagrant-destroy-if-bash')
    if values:
        for value in values:
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (
                value,)
            exitcode = subprocess.call(['vagrant', 'ssh', vagrant_box_name,
                                        '-c', full_bash_cmd], cwd=TEST_ROOT)
            if exitcode == 0:
                print('Destroying all...')
                vagrant_destroy()
                print('Recreating as needed...')
                vagrant_up_or_resume(vagrant_box_name)

    values = parsed_headers.get('vagrant-precondition-bash')
    if values:
        for value in values:
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (
                value,)
            _run_capture_output(['vagrant', 'ssh', vagrant_box_name,
                                 '-c', full_bash_cmd], cwd=TEST_ROOT)


def handle_postconditions(postconditions_list):
    for key, value in postconditions_list:
            evald_value = eval(value)
            assert eval(value), "value of " + value + " was " + str(
                evald_value)


def call_vagrant(*args):
    env_for_subprocess = os.environ.copy()
    env_for_subprocess['VAGRANT_DEFAULT_PROVIDER'] = 'libvirt'
    argv = ['vagrant']
    argv.extend(args)
    print('$', *argv, end='')
    now = datetime.datetime.utcnow()
    try:
        output = _run_capture_output(
            argv,
            cwd=TEST_ROOT,
            env=env_for_subprocess,
        )
        nowagain = datetime.datetime.utcnow()
        print(' [%d sec]' % ((nowagain - now).seconds,))
    except:
        # Finish the line so exceptions don't show up on the same line
        # as informational text, then raise the exception so the program
        # can fail.
        print('')
        raise
    return output

def parse_test_by_filename(filename):
    lines = open(filename).read().split('\n')
    position_of_blank_line = lines.index('')

    headers, test_script = (lines[:position_of_blank_line],
                            lines[position_of_blank_line+1:])

    parsed_headers, postconditions, cleanups = parse_test_file(headers)
    return parsed_headers, postconditions, cleanups, headers, test_script


def run_one_test(filename):
    parsed_headers, postconditions, cleanups, headers, test_script = parse_test_by_filename(filename)

    # Make the VM etc., if necessary.
    handle_headers(parsed_headers)
    print("*** Running test from file:", filename)
    print(" -> Extra info:", repr(headers))

    # Run the test script, using pexpect to track its output.
    try:
        handle_test_script(parsed_headers['vagrant-box'], test_script)
    except Exception as e:
        print(e)
        raise
        print('Dazed and confused, but trying to continue.')

    # Run any sanity-checks in the test script, as needed.
    handle_postconditions(postconditions)

    # If the test knows it needs to do some cleanup, e.g. destroying
    # its VM, then do so.
    handle_cleanups(parsed_headers, cleanups)


def uninstall_sandstorm(vagrant_box_name):
    for cmd in [
            'sudo pkill -9 sandstorm || true',
            'sudo rm -rf /opt/sandstorm',
            'sudo rm -rf $HOME/sandstorm',
            'if [ -e /proc/sys/kernel/unprivileged_userns_clone  ] ; then echo 0 | sudo dd of=/proc/sys/kernel/unprivileged_userns_clone ; fi',
            'sudo pkill -9 sudo || true',
            'sudo hostname localhost',
            'sudo modprobe fuse',  # Workaround for issue #858
    ]:
        exitcode = subprocess.call(['vagrant', 'ssh', vagrant_box_name,
                                    '-c', cmd], cwd=TEST_ROOT)
        assert (exitcode == 0), "Ran %s, got %s" % (cmd, exitcode)


def handle_cleanups(parsed_headers, cleanups):
    for key, value in cleanups:
        print('Doing cleanup task', value)
        try:
            eval(value)
        except Exception as e:
            print('Ran into error', e)
            raise
            print('Dazed and confused, but trying to continue.')

def vagrant_up_or_resume(vm):
    # First, try a resume.
    needs_up = False
    try:
        output = call_vagrant('resume', vm)
        if 'VM not created. Moving on' in output:
            # We need to do a vagrant up instead. Continue executing
            # the rest of the function.
            pass
        elif 'Domain is not created' in output:
            pass  # also need vagrant up
        elif 'Domain is not suspended' in output:
            pass  # also need vagrant up
        else:
            return output
    except Exception as e:
        print("** Warning: exception during vagrant resume", vm)
        print("Going to do vagrant up instead.")
        print(e)

    output = call_vagrant('up', vm)
    return output

def main():
    parser = argparse.ArgumentParser(description='Run Sandstorm install script tests.')
    parser.add_argument('--rsync',
                        help='Perform `vagrant rsync` to ensure the install.sh in the VM is current.',
                        action='store_true',
    )
    parser.add_argument('--uninstall-first',
                        help='Before running tests, uninstall Sandstorm within the VMs.',
                        action='store_true',
    )
    parser.add_argument('--halt-afterward',
                        help='After running the tests, stop the VMs.',
                        action='store_true',
    )
    parser.add_argument('testfiles', metavar='testfile', nargs='*',
                        help='A *.t file to run (multiple is OK; empty testfile sequence means run all)',
                        default=[],
    )

    args = parser.parse_args()

    testfiles = args.testfiles
    if not testfiles:
        testfiles = sorted(glob.glob('*.t'))

    # Sort testfiles by the Vagrant box they use. That way, we can minimize
    # up/resume/suspend churn.
    testfiles = sorted(testfiles,
                       key=lambda filename: parse_test_by_filename(filename)[0]['vagrant-box'])

    keep_going = True

    previous_vagrant_box = None
    this_vagrant_box = None

    boxes_that_have_been_prepared = {}

    for filename in testfiles:
        previous_vagrant_box = this_vagrant_box
        this_vagrant_box = parse_test_by_filename(filename)[0]['vagrant-box']
        if this_vagrant_box != previous_vagrant_box:
            # Suspend or halt the previous VM.
            stop_action = 'suspend'
            if args.halt_afterward:
                stop_action = 'halt'
            if previous_vagrant_box:
                call_vagrant(stop_action, previous_vagrant_box)

            # Prepare this box.
            #
            # First, make sure it's online.
            vagrant_up_or_resume(this_vagrant_box)

            if this_vagrant_box not in boxes_that_have_been_prepared:
                # If we were told to uninstall first, let's do that.
                if args.uninstall_first:
                    print('** Uninstalling Sandstorm from', this_vagrant_box)
                    uninstall_sandstorm(this_vagrant_box)
                # Same with rsyncing.
                if args.rsync:
                    print('** rsync-ing the latest Sandstorm installer etc. to', this_vagrant_box)
                    call_vagrant('rsync', this_vagrant_box)
                # Indicate that no further prep is needed.
                boxes_that_have_been_prepared[this_vagrant_box] = True
        try:
            if keep_going:
                run_one_test(filename)
        except:
            keep_going = False
            logging.exception("Alas! A test failed!")

    # If we need to stop the VMs, now's a good time to stop
    # them.
    if args.halt_afterward:
        subprocess.check_output(
            ['vagrant', 'halt'],
            cwd=TEST_ROOT,
    )

    if not keep_going:
        sys.exit(1)

    sys.exit(0)


if __name__ == '__main__':
    main()
