#!/bin/python
import argparse, shlex, subprocess, os, getpass

# from https://stackoverflow.com/a/4760274/259046
def runProcess(exe):
    p = subprocess.run(shlex.split(exe), stderr=subprocess.STDOUT)
    while(True):
        if not isinstance(p, subprocess.CompletedProcess):
            retcode = p.poll()
        else:
            retcode = p.returncode
        
        stdout = p.stdout
        print(stdout)
        if retcode is not None:
            if retcode != 0:
                exit(retcode)
            else:
                break




parser = argparse.ArgumentParser(description='Build Sandstorm using an Ubuntu 20.04 Docker/OCI container')
parser.add_argument("action", choices=["make", "prepare", "shell"], default="make", nargs="?")
parser.add_argument('--container-builder', dest="container_builder", default='podman', help='Command you run for building container from command line')
parser.add_argument('--container-runner', dest="container_runner", default='podman', help='Command you run for running container from command line')
parser.add_argument('args', nargs=argparse.REMAINDER)

args = parser.parse_args()

def prepare():
    script ="{builder_cmd} build .  -t sandstorm-build".format(builder_cmd=args.container_builder)
    print(script)
    runProcess(script)

def prepare_cmd(command):
    return "{runner_cmd} run --rm -ti \
        -v {pwd}:/sandstorm \
        -v {pwd}/scripts:/helpers \
        -v {pwd}/scripts/podman-entrypoint.sh:/podman-entrypoint.sh \
        --userns=keep-id \
        --entrypoint=/podman-entrypoint.sh \
        --cap-add=SYS_PTRACE  sandstorm-build {command} {args}".format(
            runner_cmd=args.container_runner, 
            pwd=os.getcwd(),
            command=command,
            args=' '.join(args.args)
        )

        #   

def make():
    script = prepare_cmd("make")
    print(script)
    runProcess(script)

def shell():
    script = prepare_cmd("bash")
    print(script)
    runProcess(script)

prepare()

if (args.action == "make"):
    make()

if (args.action == "shell"):
    shell()





