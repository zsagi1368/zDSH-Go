/** Startup variables required by native executables before model evaluation. */

/** Native executable search, Windows system paths, and sandbox temporary paths retained in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/**
 * Harness home directories a program keeps.
 *
 * A program that shells out to the `dsh` CLI — the documented way to manage a
 * profile from a session — has to reach the SAME installation that is running
 * it. Without these the CLI resolves the default home under the OS home
 * directory, so `dsh plugin --profile web add …` installs into a different
 * installation and the user finds nothing where they are running. The names
 * carry no secret: they are directory paths the running host already
 * advertises, and the sandbox policy — not the environment — decides what a
 * program may do with them.
 */
export const HARNESS_HOME_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['DSH_HOME', 'DSH_BRANCH_HOME', 'DSH_AGENTS_HOME'])
