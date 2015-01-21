/* configure.h for libseccomp as needed by Sandstorm build */

/* Define to 1 if you have the <linux/seccomp.h> header file.
 * This seems unnecessary since system.h contains a copy of all the defs, so
 * we'll just not use it for the Sandstorm build. */
/* #define HAVE_LINUX_SECCOMP_H 1 */

/* All other macros potentially defined in configure.h turn out not to be used
 * by libseccomp. It's just autoheader spam. */

