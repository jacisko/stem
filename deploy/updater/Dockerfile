# The updater: the one container that holds the docker socket, so that the
# server does not have to. It runs updater.sh and nothing else — see there.
# docker:cli ships the compose plugin, which is all the script needs.
FROM docker:27-cli
COPY updater.sh /usr/local/bin/stem-updater
RUN chmod +x /usr/local/bin/stem-updater
ENTRYPOINT ["/usr/local/bin/stem-updater"]
