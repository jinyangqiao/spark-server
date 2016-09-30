/**
*    Copyright (C) 2013-2014 Spark Labs, Inc. All rights reserved. -  https://www.spark.io/
*
*    This program is free software: you can redistribute it and/or modify
*    it under the terms of the GNU Affero General Public License, version 3,
*    as published by the Free Software Foundation.
*
*    This program is distributed in the hope that it will be useful,
*    but WITHOUT ANY WARRANTY; without even the implied warranty of
*    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*    GNU Affero General Public License for more details.
*
*    You should have received a copy of the GNU Affero General Public License
*    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
*    You can download the source here: https://github.com/spark/spark-server
*/

var settings = require('../settings.js');
var CoreController = require('../lib/CoreController.js');

var Api = require('./api_v1.js');
var utilities = require("../lib/utilities.js");
var logger = require('../lib/logger.js');

var when = require('when');
var sequence = require('when/sequence');
var pipeline = require('when/pipeline');

var moment = require('moment');

var EventsApi = {
    loadViews: function (app) {

        //  GET /v1/events[/:event_name]
        //  GET /v1/devices/events[/:event_name]
        //  GET /v1/devices/:device_id/events[/:event_name]

        app.get('/v1/events', EventsApi.get_events);
        app.get('/v1/events/:event_name', EventsApi.get_events);

        app.get('/v1/devices/events', EventsApi.get_my_events);
        app.post('/v1/devices/events', EventsApi.send_an_event);
        app.get('/v1/devices/events/:event_name', EventsApi.get_my_events);

        app.get('/v1/devices/:coreid/events', EventsApi.get_core_events);
        app.get('/v1/devices/:coreid/events/:event_name', EventsApi.get_core_events);
        
        app.get('/v1/products/:productIdOrSlug/events', app.oauth.authenticate(), EventsApi.get_product_events);
    },


    //-----------------------------------------------------------------

    pipeEvents: function (socket, req, res, next, filterCoreId, filterProductId) {
        var userid = Api.getUserOrCustomerID(req);
        if(!userid) {
        	return next();
        }

        /*
         Start SSE
         */

        req.socket.setNoDelay();

        res.writeHead(200, {
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        });
        res.write(":ok\n\n");


        var _idleTimer = null;
        var _lastMessage = null;
        var keepAlive = function() {
            if (((new Date()) - _lastMessage) >= 9000) {
                _lastMessage = new Date();
                res.write("\n");
                checkSocket();
            }
        };

        //if nothing gets sent for 9 seconds, send a newline.
        var aliveInterval = setInterval(keepAlive, 3000);

        var checkSocket = function () {
            try {
                if (!socket) {
                    cleanup();
                    return false;
                }

                if (res.socket.destroyed) {
                    logger.log("Socket destroyed, cleaning up Event listener");
                    cleanup();
                    return false;
                }
            }
            catch (ex) {
                logger.error("pipeEvents - error checking socket ", ex);
            }
            return true;
        };

        var cleanup = function () {
            try {
                if (socket) {
                    socket.close();
                    socket = null;
                }
            }
            catch (ex) {
                logger.error("pipeEvents - event socket close err: ", ex);
            }

            try {
                if (res.socket) {
                    res.socket.end();
                }
                res.end();
            }
            catch (ex) {
                logger.error("pipeEvents - response close err: ", ex);
            }

            try {
                if (aliveInterval) {
                    clearInterval(aliveInterval);
                    aliveInterval = null;
                }
            }
            catch (ex) {
                logger.error("pipeEvents - clear interval err: ", ex);
            }

        };


        //  http://www.whatwg.org/specs/web-apps/current-work/#server-sent-events
        var writeEventGen = function (isPublic) {
            return function (name, data, ttl, published_at, coreid, productid) {
                if (filterCoreId && (filterCoreId != coreid)) {
                    return;
                }
                
                if (filterProductId && (filterProductId != productid)) {
                    return;
                }

                if (!checkSocket()) {
                    return;
                }
                
                if(!filterProductId && !Api.hasDevice(coreid, userid)) {
                	return;
                }
                
                if(filterProductId && !Api.hasProduct(productid, userid)) {
                	return;
                }

                try {
                    _lastMessage = new Date();

                    //TODO: if the user puts the userid elsewhere in the event name... it's gonna get removed.
                    name = (name) ? name.toString().replace(userid + "/", "") : null;

                    var obj = {
                        data: data ? data.toString() : null,
                        ttl: ttl ? ttl.toString() : null,
                        published_at: (published_at) ? published_at.toString() : null,
                        coreid: (coreid) ? coreid.toString() : null,
                        productid: (productid) ? productid.toString() : null
                    };
                    res.write("event: " + name + "\n");
                    res.write("data: " + JSON.stringify(obj) + "\n\n"); //~100 ms for 100,000 stringifies
                }
                catch (ex) {
                    logger.error("pipeEvents - write error: " + ex);
                }

                //OTHER HEADERS:
                //retry: ?
                //id: ? //if we want to support resuming
                //TODO: escape newlines in message?
            };
        };

        socket.on('public', writeEventGen(true));
        socket.on('private', writeEventGen(false));

        req.on("close", cleanup);
        req.on("end", cleanup);
        res.on("close", cleanup);
        res.on("finish", cleanup);
        //res.setTimeout(30 * 1000, cleanup);
    },


    get_events: function (req, res, next) {
        var name = req.params.event_name;
        name = name || "";
        var socket = new CoreController();

        var userid = Api.getUserOrCustomerID(req);
        if(!userid) {
        	return next();
        }
//        if (userid) {
//            socket.authorize(userid);
//        }

        //-----------------------------------
        //get firehose and my private events.
        //socket.subscribe(true, name);
        //socket.subscribe(true, name);
        socket.subscribe(false, name, userid);


        //send it all through
        EventsApi.pipeEvents(socket, req, res, next);
    },
    get_my_events: function (req, res, next) {
        var name = req.params.event_name;
        name = name || "";
        var socket = new CoreController();

        var userid = Api.getUserOrCustomerID(req);
        if(!userid) {
        	return next();
        }
//        if (userid) {
//            socket.authorize(userid);
//        }

        //-----------------------------------
        //get my events:
        //socket.subscribe(true, name);
        socket.subscribe(true, name, userid);
        socket.subscribe(false, name, userid);

        //don't filter by core id
        EventsApi.pipeEvents(socket, req, res, next);
    },
    get_core_events: function (req, res, next) {
        var name = req.params.event_name;
        var socket = new CoreController();
        name = name || "";
        var coreid = req.coreID || req.params.coreid;

        var userid = Api.getUserOrCustomerID(req);
        if(!userid) {
        	return next();
        }
        //check if core is owned
        if(!Api.hasDevice(coreid, userid)) {
        	return next();
        }
//        if (userid) {
//            socket.authorize(userid);
//        }


        //-----------------------------------
        //get core events
        //socket.subscribe(true, name);
        socket.subscribe(true, name, userid,coreid);
        socket.subscribe(false, name, userid,coreid);

        //-----------------------------------
        //filter to core id
        EventsApi.pipeEvents(socket, req, res, next, coreid);
    },


    send_an_event: function (req, res, next) {
        var userid = Api.getUserOrCustomerID(req),
            socketID = Api.getSocketID(userid),
            eventName = req.body.name,
            data = req.body.data,
            ttl = req.body.ttl || 60,
            private_str = req.body.private;
		
		if(!userid) {
			return next();
		}
		
        var is_public = (!private_str || (private_str == "") || (private_str == "false"));

        var socket = new CoreController(socketID);
        var success = socket.sendEvent(is_public,
            eventName,
            userid,
            data,
            parseInt(ttl),
            moment().toISOString(),
            userid
        );

        var autoClose = setTimeout(function () {
            socket.close();
            res.json({ok: success});
        }, 250);
    },
    
    get_product_events: function (req, res, next) {
        var name = req.params.event_name;
        var socket = new CoreController();
        name = name || "";
        var productid = req.params.productIdOrSlug;

        var userid = Api.getUserOrCustomerID(req);
        if(!userid) {
        	return next();
        }
        //check if product is owned by user
        if(!Api.hasProduct(productid, userid)) {
        	return next();
        }
//        if (userid) {
//            socket.authorize(userid);
//        }


        //-----------------------------------
        //get product events
        //socket.subscribe(true, name);
        socket.subscribe(true, name, userid);
        socket.subscribe(false, name, userid);

        //-----------------------------------
        //filter to core id
        EventsApi.pipeEvents(socket, req, res, next, null, productid);
    },

    _: null
};


module.exports = EventsApi;