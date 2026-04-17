# Service Management

ccgateway can run as a systemd user service that auto-starts on boot and restarts on failure.

## Install as a service

```bash
ccg install
```

This creates and starts a systemd user service that:
- Auto-starts on boot
- Restarts on failure
- Sources `~/.ccgateway/.env` for bot tokens

## Keep running after logout

```bash
loginctl enable-linger $USER
```

Without this, systemd kills user services when you log out.

## Standard systemd commands

```bash
systemctl --user status ccgateway     # Check status
systemctl --user restart ccgateway    # Restart
systemctl --user stop ccgateway       # Stop
journalctl --user -u ccgateway -f     # Follow logs
```

## Uninstall the service

```bash
ccg uninstall
```

Stops the service and removes the systemd unit file.

## Running in foreground

For development or debugging, run directly:

```bash
source ~/.ccgateway/.env && ccg start
```

This runs in the foreground so you can see logs in real time. Ctrl+C to stop.
