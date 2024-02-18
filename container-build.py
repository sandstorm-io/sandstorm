#!/bin/python
import argparse, shlex, subprocess, os

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

args = parser.parse_args()

def prepare():
    script = args.container_builder + ' build --build-arg HOST_UID='+ str(os.getuid()) + ' --build-arg HOST_GID=' + str(os.getgid()) + ' . -t sandstorm-build'
    print(script)
    runProcess(script)

def make():
    script = args.container_runner + ' run --rm -ti -v ' + os.getcwd() + ':/sandstorm  --cap-add=SYS_PTRACE --env \'USER\' sandstorm-build make'
    print(script)
    runProcess(script)

def shell():
    script = args.container_runner + ' run --rm -ti -v ' + os.getcwd() + ':/sandstorm  --cap-add=SYS_PTRACE --env \'USER\' sandstorm-build'
    print(script)
    runProcess(script)

prepare()

if (args.action == "make"):
    make()

if (args.action == "shell"):
    shell()





