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
            exit(retcode)




parser = argparse.ArgumentParser(description='Build Sandstorm using an Ubuntu 20.04 Docker/OCI container')
parser.add_argument("action", choices=["make", "prepare"], default="make", nargs="?")
parser.add_argument('--container-builder', dest="container_builder", default='podman', help='Command you run for building container from command line')
parser.add_argument('--container-runner', dest="container_runner", default='podman', help='Command you run for running container from command line')

args = parser.parse_args()

def prepare():
    runProcess(args.container_builder + ' build . -t sandstorm-build')

def make():
    runProcess(args.container_runner + ' run --rm -ti -v ' + os.getcwd() + ':/sandstorm -u ' +  str(os.getuid()) + ' --cap-add=SYS_PTRACE --env \'USER\' sandstorm-build make')


prepare()

if (args.action == "make"):
    make()





