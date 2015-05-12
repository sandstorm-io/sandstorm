import glob
import os
import pexpect
import subprocess
import re

def _expect(line, current_cmd, do_re_escape=True, do_detect_slow=True, strip_comments=True,
            verbose=True):
    timeout = 1
    if do_detect_slow:
        if line.startswith('$[slow]'):
            print 'Slow line...'
            timeout = 30
            line = line.replace('$[slow]', '', 1)

    if verbose:
        print 'expecting', line

    if do_re_escape:
        line = re.escape(line)

    current_cmd.expect(line, timeout=timeout)


TEST_ROOT=os.path.dirname(os.path.abspath(__file__))
SANDSTORM_SOURCE_TREE=os.path.abspath(os.path.join(os.path.abspath(__file__), '..', '..'))
SANDSTORM_IN_HOME=os.path.join(os.environ['HOME'], 'sandstorm')

def vagrant_destroy():
    subprocess.check_output(['vagrant', 'destroy', '-f'], cwd=TEST_ROOT)

def handle_test_script(lines):
    current_cmd = None
    next_timeout = 1

    for line in lines:
        # Figure out what we want to do, given this line.
        if line.startswith('$[run]'):
            arg = line.replace('$[run]', '')
            arg = 'vagrant ssh -c "' + arg + '"'
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

            # Then we sendline the right side.
            current_cmd.sendline(right)
        else:
            # For now, assume the action is expect.
            _expect(line, current_cmd=current_cmd)


def handle_headers(headers_list):
    postconditions = []
    cleanups = []

    for header in headers_list:
        key, value = map(lambda s: s.strip(), header.split(':'))
        key = key.lower()
        if key == 'title':
            print 'Test title:', value

        if key == 'vagrant-destroy-if-bash':
            print 'hmm'
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (value,)
            exitcode = subprocess.call(['vagrant', 'ssh', '-c', full_bash_cmd], cwd=TEST_ROOT)
            if exitcode == 0:
                print 'Destroying...'
                vagrant_destroy()
                print 'Recreating...'
                vagrant_up()

        if key == 'vagrant-precondition-bash':
            full_bash_cmd = 'if [ %s ] ; then exit 0 ; else exit 1 ; fi' % (value,)
            subprocess.check_output(['vagrant', 'ssh', '-c', full_bash_cmd], cwd=TEST_ROOT)

        if key == 'precondition':
            evald_value = eval(value)
            assert eval(value), "value of " + value + " was " + str(evald_value)

        if key == 'cwd':
            evald_value = eval(value)
            print 'chdir() ing to', evald_value
            os.chdir(evald_value)

        if key == 'postcondition':
            postconditions.append([key, value])

        if key == 'cleanup':
            cleanups.append([key, value])

    return postconditions, cleanups


def handle_postconditions(postconditions_list):
    for key, value in postconditions_list:
            evald_value = eval(value)
            assert eval(value), "value of " + value + " was " + str(evald_value)

def vagrant_up():
    subprocess.check_output(['vagrant', 'up'], cwd=TEST_ROOT)


def run_one_test(filename, state):
    vagrant_up()
    lines = open(filename).read().split('\n')
    position_of_blank_line = lines.index('')

    headers, test_script = lines[:position_of_blank_line], lines[position_of_blank_line+1:]

    print repr(headers)
    postconditions, cleanups = handle_headers(headers)
    handle_test_script(test_script)

    handle_postconditions(postconditions)
    restore_state(state)
    handle_cleanups(cleanups)


def handle_cleanups(cleanups):
    for key, value in cleanups:
        print 'Doing cleanup task', value
        try:
            eval(value)
        except Exception, e:
            print 'Ran into error', e
            print 'Dazed and confused, but trying to continue.'


def save_state():
    return {'cwd': os.getcwd()}


def restore_state(state):
    os.chdir(state['cwd'])


def main():
    for filename in glob.glob('*.t'):
        state = save_state()
        run_one_test(filename, state)



if __name__ == '__main__':
    main()
