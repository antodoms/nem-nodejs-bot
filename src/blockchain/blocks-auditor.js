/**
 * Part of the evias/nem-nodejs-bot package.
 *
 * NOTICE OF LICENSE
 *
 * Licensed under MIT License.
 *
 * This source file is subject to the MIT License that is
 * bundled with this package in the LICENSE file.
 *
 * @package    evias/nem-nodejs-bot
 * @author     Grégory Saive <greg@evias.be> (https://github.com/evias)
 * @license    MIT License
 * @copyright  (c) 2017, Grégory Saive <greg@evias.be>
 * @link       https://github.com/evias/nem-nodejs-bot
 */

(function() {

    var nemAPI = require("nem-api");

    /**
     * class BlocksAuditor implements a simple blocks reading Websocket
     * subscription.
     * 
     * This auditor allows our Bot Server to be aware of disconnections
     * and broken Websocket subscriptions (happening without errors..)
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var BlocksAuditor = function(chainDataLayer) {
        var api_ = nemAPI;

        this.blockchain_ = chainDataLayer;
        this.db_ = this.blockchain_.getDatabaseAdapter();
        this.nemsocket_ = null;
        this.nemConnection_ = null;
        this.nemSubscriptions_ = {};

        this.logger = function() {
            return this.blockchain_.logger();
        };

        this.config = function() {
            return this.blockchain_.conf_;
        };

        /**
         * Configure the BlocksAuditor websocket connections. This class
         * will connect to following websocket channels:
         * 
         * - /errors
         * - /blocks/new
         * 
         * Standard API Disconnection is handled in the `websocketErrorHandler`
         * closure and will issue an automatic reconnection. This process happens
         * approximately every 10 minutes.
         * 
         * @return  {BlocksAuditor}
         */
        this.connectBlockchainSocket = function() {
            var self = this;

            // initialize the socket connection with the current
            // blockchain instance connected endpoint
            self.nemsocket_ = new api_(self.blockchain_.getNetwork().host + ":" + self.blockchain_.getNetwork().port);

            // define helper for websocket error handling, the NEM Blockchain Socket
            // should be alive as long as the bot is running so we will always try
            // to reconnect, unless the bot has been stopped from running or has crashed.
            var websocketErrorHandler = function(error) {
                var regexp_LostConn = new RegExp(/Lost connection to/);
                if (regexp_LostConn.test(error)) {
                    // connection lost, re-connect

                    self.logger()
                        .warn("[NEM] [AUDIT-SOCKET] [DROP]", __line,
                            "Connection lost with node: " + JSON.stringify(self.nemsocket_.socketpt) + ".. Now re-connecting.");

                    self.connectBlockchainSocket();
                    return true;
                }
                //XXX ECONNREFUSED => switch node

                // uncaught error happened
                self.logger()
                    .error("[NEM] [AUDIT-SOCKET] [ERROR]", __line, "Uncaught Error: " + error);
            };

            // Connect to NEM Blockchain Websocket now
            self.nemConnection_ = self.nemsocket_.connectWS(function() {
                // on connection we subscribe only to the /errors websocket.
                // BlocksAuditor will open

                try {
                    self.logger()
                        .info("[NEM] [AUDIT-SOCKET] [CONNECT]", __line, "Connection established with node: " + JSON.stringify(self.nemsocket_.socketpt));

                    // NEM Websocket Error listening
                    self.logger().info("[NEM] [AUDIT-SOCKET]", __line, 'subscribing to /errors.');
                    self.nemSubscriptions_["/errors"] = self.nemsocket_.subscribeWS("/errors", function(message) {
                        self.logger()
                            .error("[NEM] [AUDIT-SOCKET] [ERROR]", __line, "Error Happened: " + message.body);
                    });

                    // NEM Websocket new blocks Listener
                    self.logger().info("[NEM] [AUDIT-SOCKET]", __line, 'subscribing to /blocks/new.');
                    self.nemSubscriptions_["/blocks/new"] = self.nemsocket_.subscribeWS("/blocks/new", function(message) {
                        var parsed = JSON.parse(message.body);
                        self.logger().info("[NEM] [AUDIT-SOCKET]", __line, 'new_block(' + JSON.stringify(parsed) + ')');

                        var block = new self.db_.NEMBlockHeight({
                            blockHeight: parsed.height,
                            createdAt: new Date().valueOf()
                        });
                        block.save();
                    });

                } catch (e) {
                    // On Exception, restart connection process
                    self.connectBlockchainSocket();
                }

            }, websocketErrorHandler);

            self.registerBlockDelayAuditor();
            return self;
        };

        /**
         * This method should register an interval to run every *10 minutes*
         * which will check the date of the last saved `NEMBlockHeight` entry.
         * If the block entry is older than 5 minutes, the blockchain endpoint
         * will be switched automatically.
         * 
         * After this has been, you will usually need to refresh your Websocket
         * connections as shows the example use case in server.js.
         * 
         * @param   {Function}  callback
         * @return  {BlocksAuditor}
         */
        this.registerBlockDelayAuditor = function(callback) {
            var self = this;

            // add fallback checker for Block Times, if we didn't get a block
            // in more than 5 minutes, change Endpoint.
            var aliveInterval = setInterval(function() {

                // fetch blocks from DB to get the latest time of fetch
                self.db_.NEMBlockHeight.findOne({}, null, { sort: { blockHeight: -1 } }, function(err, block) {
                    if (err) {
                        // error happened
                        self.logger().warn("[NEM] [AUDIT-SOCKET] [ERROR]", __line, "DB Read error for NEMBlockHeight: " + err);

                        clearInterval(aliveInterval);
                        self.connectBlockchainSocket();
                        return false;
                    }

                    // maximum age is 5 minute old
                    var limitAge = new Date().valueOf() - (5 * 60 * 1000);
                    if (!block || block.createdAt <= limitAge) {
                        // need to switch node.
                        self.logger().warn("[NEM] [AUDIT-SOCKET]", __line, "Socket connection lost with node: " + JSON.stringify(self.blockchain_.node_.host) + ".. Now hot-switching Node.");
                        self.blockchain_ = self.blockchain_.autoSwitchNode();

                        // after connection was established to new node, we should fetch
                        // the last block height to start fresh.
                        self.websocketFallbackHandler();
                    }

                    return false;
                });
            }, 10 * 60 * 1000);

            return self;
        };

        /**
         * This method uses the SDK to fetch the latest block height
         * from the NEM blockchain Node configured in `this.blockchain_`.
         * 
         * @return void
         */
        this.websocketFallbackHandler = function() {
            var self = this;

            // fetch the latest block height and save in database
            self.blockchain_.nem()
                .com.requests.chain.height(self.blockchain_.endpoint())
                .then(function(res) {
                    res = res.data;

                    self.logger().info("[NEM] [AUDIT-HTTP]", __line, 'new_block(' + JSON.stringify(res) + ')');

                    var block = new self.db_.NEMBlockHeight({
                        blockHeight: res.height,
                        createdAt: new Date().valueOf()
                    });
                    block.save();
                });
        };

        var self = this; {
            // nothing more done on instanciation
        }
    };


    module.exports.BlocksAuditor = BlocksAuditor;
}());