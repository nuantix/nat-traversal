const util = require('util');
const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');

let socketPipeId = 1;

class SocketPipe {
  constructor(targetHost, targetPort, relayHost, relayPort, options, type) {

    // This class is an event emitter. Initialize it
    EventEmitter.call(this);

    this.id = socketPipeId;
    socketPipeId += 1;

    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.relayHost = relayHost;
    this.relayPort = relayPort;
    this.options = options;
    this.type = type;

    this.targetSocket = undefined;
    this.targetSocketPending = true;
    this.buffer = [];

    if (!this.options.silent) {
      console.log(`[${this}] Created new pending SocketPipe.`);
    }

    this._openRelayEnd();

  }

  toString() {
    return `${this.type}:${this.id}`;
  }

  _openRelayEnd() {

    // Use TLS?
    if (this.options.relayTls) {

      if (!this.options.silent) {
        console.log(`[${this}] Socket pipe will use TLS connection to connect to relay server.`);
      }

      this.relaySocket =
        tls.connect(
          this.relayPort,
          this.relayHost,
          {
            rejectUnauthorized: this.options.relayVerifyCert,
          },
          () => {
            if (!this.options.silent) {
              console.log(`[${this}] Created new TLS connection.`);
            }

            // Configure socket for keeping connections alive
            this.relaySocket.setKeepAlive(true, 120 * 1000);

            this._requestAuthorization();
          },
        );

    } else {

      if (!this.options.silent) {
        console.log(`[${this}] Socket pipe will TCP connection to connect to relay server.`);
      }

      // Or use TCP
      this.relaySocket = new net.Socket();

      this.relaySocket.connect(
        this.relayPort,
        this.relayHost,
        () => {
          if (!this.options.silent) {
            console.log(`[${this}] Created new TCP connection.`);
          }

          // Configure socket for keeping connections alive
          this.relaySocket.setKeepAlive(true, 120 * 1000);

          this._requestAuthorization();

        },
      );

    }

    // We have a relay socket - now register its handlers

    // On data
    this.relaySocket.on(
      'data',
      (data) => {

        // Got data - do we have a target socket?
        if (this.targetSocket === undefined) {

          // Create a target socket for the relay socket - connecting to the target
          this._openServiceEnd(this.host, this.targetPort);

          this.emit('pair');
        }

        // Is the target socket still connecting? If so, are we buffering data?
        if (this.targetSocketPending) {

          // Store the data until we have a target socket
          this.buffer[this.buffer.length] = data;

        } else {

          try {
            // Or just pass it directly
            this.targetSocket.write(data);
          } catch (ex) {
            console.error(`[${this}] Error writing to target socket: `, ex);
          }

        }
      },
    );

    // On closing
    this.relaySocket.on(
      'close',
      (hadError) => {

        if (hadError) {
          console.error(`[${this}] Relay socket closed with error.`);
        }

        if (this.targetSocket !== undefined) {

          // Destroy the other socket
          this.targetSocket.destroy();

        } else {

          // Signal we are closing - server closed the connection
          this.emit('close');
        }
      },
    );

    this.relaySocket.on('error', (error) => {
      console.error(`[${this}] Error with relay socket: `, error);
    });

  }

  _requestAuthorization() {

    // Got a secret?
    if (this.options.relaySecret) {
      if (!this.options.silent) {
        console.log(`[${this}] Sending authorization to relay server and waiting for incoming data.`);
      }

      try {
        // Write it to the relay!
        this.relaySocket.write(this.options.relaySecret);
      } catch (ex) {
        console.error(`[${this}] Error writing to relay socket: `, ex);
      }

    }

  }

  _openServiceEnd(targetHost, targetPort) {

    if (!this.options.silent) {
      console.log(`[${this}] Authorized by relay server. Creating new connection to target ${targetHost}:${targetPort}...`);
    }

    // Create a new target socket
    this.targetSocket = new net.Socket();

    // Connect it immediately
    this.targetSocket.connect(
      targetPort,
      targetHost,
      () => {

        if (!this.options.silent) {
          console.log(`[${this}] Connected to target ${targetHost}:${targetPort}.`);
        }

        // Configure socket for keeping connections alive
        this.targetSocket.setKeepAlive(true, 120 * 1000);

        // Connected, not pending anymore
        this.targetSocketPending = false;

        // And if we have any buffered data, forward it
        try {
          for (const bufferItem of this.buffer) {
            this.targetSocket.write(bufferItem);
          }
        } catch (ex) {
          console.error(`[${this}] Error writing to target socket: `, ex);
        }


        // Clear the array
        this.buffer.length = 0;
      },
    );

    // Got data from the target socket?
    this.targetSocket.on('data', (data) => {

      try {
        // Forward it!
        this.relaySocket.write(data);
      } catch (ex) {
        console.error(`[${this}] Error writing to relay socket: `, ex);
      }

    });

    this.targetSocket.on('error', (hadError) => {

      if (hadError) {
        console.error(`[${this}] Service socket was closed with error: `, hadError);
      }

      this.relaySocket.terminate();
    });

  }

  terminate() {

    if (!this.options.silent) {
      console.log(`[${this}] Terminating socket pipe...`);
    }

    this.removeAllListeners();
    this.relaySocket.destroy();
  }
}

util.inherits(SocketPipe, EventEmitter);


class NATTraversalClient {

  constructor(targetHost, targetPort, relayHost, relayPort, options = {
    targetTls: false,
    targetVerifyCert: true,
    relayTls: true,
    relayVerifyCert: false,
    relaySecret: null,
    relayNumConn: 1,
    silent: false,
  }) {

    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.relayHost = relayHost;
    this.relayPort = relayPort;
    this.options = options;

    this.socketPipes = [];
  }

  start() {
    // Create pending socketPipes
    for (let i = 0; i < this.options.relayNumConn; i += 1) {
      this._createSocketPipe(this.targetHost, this.targetPort, this.relayHost, this.relayPort, this.options);
    }
  }

  terminate() {
    this.terminating = true;
    for (const socketPipe of this.socketPipes) {
      socketPipe.terminate();
    }
  }

  _createSocketPipe(targetHost, targetPort, relayHost, relayPort, options) {

    // Create a new socketPipe
    const socketPipe = new SocketPipe(targetHost, targetPort, relayHost, relayPort, options, 'relay');
    this.socketPipes.push(socketPipe);

    socketPipe.on(
      'pair',
      () => {

        // Create a new pending socketPipe
        this._createSocketPipe(targetHost, targetPort, relayHost, relayPort, options);
      },
    );

    socketPipe.on(
      'close',
      () => {

        // Server closed the connection

        // Remove paired pipe
        this._removeSocketPipe(socketPipe);

        // Create a new replacement socketPipe, that is pending and waiting, if required
        setTimeout(
          () => {
            if (this.terminating) {
              return;
            }

            // Create a new pending socketPipe
            this._createSocketPipe(targetHost, targetPort, relayHost, relayPort, options);
          },
          5000,
        );
      },
    );

  }

  _removeSocketPipe(socketPipe) {

    // SocketPipe closed - is it still stored by us?
    const i = this.socketPipes.indexOf(socketPipe);

    // If so, remove it
    if (i !== -1) {
      this.socketPipes.splice(i, 1);
    }
  }

}

module.exports = {
  NATTraversalClient,
};
