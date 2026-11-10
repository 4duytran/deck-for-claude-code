#!/bin/bash
# FAKE login shell of plugin-runner-probe (FAKE secrets only, never a real value). It plays the user's rc:
# exports two fake secrets, prints them on stdout AND stderr, then hands over to a bare interactive bash
# (--norc --noprofile: the probe never sources the real ~/.bashrc). Owned by S1s, not shared with S1a.
export RSH_MAPPED_TOKEN=fake-rsh-mapped-9c41e7
export RSH_OTHER_SECRET=fake-rsh-other-5d02b8
export LANG=C.UTF-8
echo "rc-banner $RSH_MAPPED_TOKEN $RSH_OTHER_SECRET"
echo "rc-banner $RSH_MAPPED_TOKEN $RSH_OTHER_SECRET" >&2
exec /bin/bash --norc --noprofile "$@"
