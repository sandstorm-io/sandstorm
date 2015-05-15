import glob
import os
import pexpect
import random
import subprocess
import sys
import re


def _expect(line, current_cmd, do_re_escape=True, do_detect_slow=True,
            strip_comments=True, verbose=True):
    timeout = 1
    if do_detect_slow:
        if line.startswith('$[slow]'):
            print 'Slow line...'
            timeout = int(os.environ.get('SLOW_TEXT_TIMEOUT', 30))
            line = line.replace('$[slow]', '', 1)

    if verbose:
        print 'expecting', line

    if do_re_escape:
        line = re.escape(line)

    current_cmd.expect(line, timeout=timeout)


TEST_ROOT = os.path.dirname(os.path.abspath(__file__))


def vagrant_destroy():
    subprocess.check_output(['vagrant', 'destroy', '-f'], cwd=TEST_ROOT)


def handle_test_script(vagrant_box_name, lines):
    current_cmd = None

    for line in lines:
        # Figure out what we want to do, given this line.
        if line.startswith('$[run]'):
            arg = line.replace('$[run]', '')
            arg = 'vagrant ssh ' + vagrant_box_name + ' -c "' + arg + '"'
            print 'starting', arg, '...'
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

        if key == 'precondition':
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
    vagrant_up(vagrant_box_name)

    values = parsed_headers.get('vagrant-destroy-if-bash')
    if values:
        for value in values:
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (
                value,)
            exitcode = subprocess.call(['vagrant', 'ssh', vagrant_box_name,
                                        '-c', full_bash_cmd], cwd=TEST_ROOT)
            if exitcode == 0:
                print 'Destroying all...'
                vagrant_destroy()
                print 'Recreating as needed...'
                vagrant_up(vagrant_box_name)

    values = parsed_headers.get('vagrant-precondition-bash')
    if values:
        for value in values:
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (
                value,)
            subprocess.check_output(['vagrant', 'ssh', vagrant_box_name,
                                     '-c', full_bash_cmd], cwd=TEST_ROOT)


def handle_postconditions(postconditions_list):
    for key, value in postconditions_list:
            evald_value = eval(value)
            assert eval(value), "value of " + value + " was " + str(
                evald_value)


def vagrant_up(vagrant_box_name):
    subprocess.check_output(['vagrant', 'up', vagrant_box_name], cwd=TEST_ROOT)


def run_one_test(filename, state):
    lines = open(filename).read().split('\n')
    position_of_blank_line = lines.index('')

    headers, test_script = (lines[:position_of_blank_line],
                            lines[position_of_blank_line+1:])

    print repr(headers)
    parsed_headers, postconditions, cleanups = parse_test_file(headers)

    # Make the VM etc., if necessary.
    handle_headers(parsed_headers)

    # Run the test script, using pexpect to track its output.
    try:
        handle_test_script(parsed_headers['vagrant-box'], test_script)
    except Exception, e:
        print e
        raise
        print 'Dazed and confused, but trying to continue.'

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
            'X=/proc/sys/kernel/unprivileged_userns_clone if [ -e $X ] ; then echo 0 | sudo dd of=$X ; fi',
            'sudo pkill -9 sudo || true',
    ]:
        exitcode = subprocess.call(['vagrant', 'ssh', vagrant_box_name,
                                    '-c', cmd], cwd=TEST_ROOT)
        assert (exitcode == 0), "Ran %s, got %s" (cmd, exitcode)


def handle_cleanups(parsed_headers, cleanups):
    for key, value in cleanups:
        print 'Doing cleanup task', value
        try:
            eval(value)
        except Exception, e:
            print 'Ran into error', e
            raise
            print 'Dazed and confused, but trying to continue.'


def save_state():
    return {'cwd': os.getcwd()}


def restore_state(state):
    os.chdir(state['cwd'])


def main():
    filenames = sys.argv[1:]
    if not filenames:
        filenames = glob.glob('*.t')
    for filename in filenames:
        state = save_state()
        run_one_test(filename, state)

if __name__ == '__main__':
    main()
