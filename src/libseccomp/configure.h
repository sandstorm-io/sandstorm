/* configure.h for libseccomp as needed by Sandstorm build */

/* Define to 1 if you have the <linux/seccomp.h> header file.
 * As of commit dead12bc788b259b148cc4d93b970ef0bd602b1a it seems that libseccomp
 * requires this header to be present -- if this is not defined, the library will
 * not compile correctly. Fine. */
#define HAVE_LINUX_SECCOMP_H 1

/* All other macros potentially defined in configure.h turn out not to be used
 * by libseccomp. It's just autoheader spam. */

