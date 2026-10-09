# Security policy

## Supported versions

Fixes are made on the latest commit of `main`. Older commits and tags are not patched.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/rudisang/cipaget/security/advisories/new>.

Include:

- what the problem is and what an attacker could do with it
- the steps or the request that shows it
- the commit you tested, your Node.js version, and any settings that matter (for example `HOST`, `API_KEY`, `HYBRID_NAVIGATION`)

Leave out personal data from the register. A made-up example is enough.

You will get a reply as soon as the maintainer is able to look at it. Please give time for a fix before you publish details.

## What counts

- Getting past the API key check
- Making the server open pages other than CIPA's public register
- Script or markup from register text running in the `/docs/` page
- One caller receiving another caller's data
- Crashing or hanging the server with a crafted request

## What does not

- How CIPA's own website behaves, or its availability
- The rate limit, the queue limits, or the cooldown working as documented
- The fact that the software reads data CIPA publishes
