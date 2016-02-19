// Horrible hack for Sandstorm. See: ../README

#include "seccomp-in.h"

#undef SCMP_VER_MAJOR
#undef SCMP_VER_MINOR
#undef SCMP_VER_MICRO

#define SCMP_VER_MAJOR 0
#define SCMP_VER_MINOR 0
#define SCMP_VER_MICRO 0

