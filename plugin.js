/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var path = require("path");
var MemoryFileSystem = require("memory-fs");
var mime = require("mime");
var Boom = require('boom');

// constructor for the middleware
module.exports = function (compiler, options) {
	if (!options) options = {};
	if (typeof options.watchOptions === "undefined") options.watchOptions = {};
	if (typeof options.watchDelay !== "undefined") {
		// TODO remove this in next major version
		console.warn("options.watchDelay is deprecated: Use 'options.watchOptions.aggregateTimeout' instead");
		options.watchOptions.aggregateTimeout = options.watchDelay;
	}
	if (typeof options.watchOptions.aggregateTimeout === "undefined") options.watchOptions.aggregateTimeout = 200;
	if (typeof options.stats === "undefined") options.stats = {};
	if (!options.stats.context) options.stats.context = process.cwd();
	if (options.lazy) {
		if (typeof options.filename === "string") {
			var str = options.filename
				.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")
				.replace(/\\\[[a-z]+\\\]/ig, ".+");
			options.filename = new RegExp("^" + str + "$");
		}
	}

	// store our files in memory
	var files = {};
	var fs = compiler.outputFileSystem = new MemoryFileSystem();

	compiler.plugin("done", function (stats) {
		// We are now on valid state
		state = true;
		// Do the stuff in nextTick, because bundle may be invalidated
		//  if a change happend while compiling
		process.nextTick(function () {
			// check if still in valid state
			if (!state) return;
			// print webpack output
			var displayStats = (!options.quiet && options.stats !== false);
			if (displayStats &&
				!(stats.hasErrors() || stats.hasWarnings()) &&
				options.noInfo)
				displayStats = false;
			if (displayStats) {
				console.log(stats.toString(options.stats));
			}
			if (!options.noInfo && !options.quiet)
				console.info("webpack: bundle is now VALID.");

			// execute callback that are delayed
			var cbs = callbacks;
			callbacks = [];
			cbs.forEach(function continueBecauseBundleAvailible(cb) {
				cb();
			});
		});

		// In lazy mode, we may issue another rebuild
		if (forceRebuild) {
			forceRebuild = false;
			rebuild();
		}
	});

	// on compiling
	function invalidPlugin() {
		if (state && (!options.noInfo && !options.quiet))
			console.info("webpack: bundle is now INVALID.");
		// We are now in invalid state
		state = false;
	}
	function invalidAsyncPlugin(compiler, callback) {
		invalidPlugin();
		callback();
	}
	compiler.plugin("invalid", invalidPlugin);
	compiler.plugin("watch-run", invalidAsyncPlugin);
	compiler.plugin("run", invalidAsyncPlugin);

	// the state, false: bundle invalid, true: bundle valid
	var state = false;

	// in lazy mode, rebuild automatically
	var forceRebuild = false;

	// delayed callback
	var callbacks = [];

	// wait for bundle valid
	function ready(fn, req) {
		if (state) return fn();
		if (!options.noInfo && !options.quiet)
			console.log("webpack: wait until bundle finished: " + req.url);
		callbacks.push(fn);
	}

	// start watching
	if (!options.lazy) {
		var watching = compiler.watch(options.watchOptions, function (err) {
			if (err) throw err;
		});
	} else {
		state = true;
	}

	function rebuild() {
		if (state) {
			state = false;
			compiler.run(function (err) {
				if (err) throw err;
			});
		} else {
			forceRebuild = true;
		}
	}

	function pathJoin(a, b) {
		return a == "/" ? "/" + b : (a || "") + "/" + b
	}

	function getFilenameFromUrl(url) {
		// publicPrefix is the folder our bundle should be in
		var localPrefix = options.publicPath || "/";
		if (url.indexOf(localPrefix) !== 0) {
			if (/^(https?:)?\/\//.test(localPrefix)) {
				localPrefix = "/" + localPrefix.replace(/^(https?:)?\/\/[^\/]+\//, "");
				// fast exit if another directory requested
				if (url.indexOf(localPrefix) !== 0) return false;
			} else return false;
		}
		// get filename from request
		var filename = url.substr(localPrefix.length);
		if (filename.indexOf("?") >= 0) {
			filename = filename.substr(0, filename.indexOf("?"));
		}
		return filename ? pathJoin(compiler.outputPath, filename) : compiler.outputPath;
	}

	// The plugin function
	
	function webpackDevPlugin(server, pluginOptions, next) { //(req, res, next) {
		server.route({
			method: 'GET',
			path: options.publicPath + '{filename}',
			handler: function (request, reply) {
				var path, 
					index = request.url.path.indexOf(options.publicPath);
				
				if (index >= 0) {
					path = request.url.path.substring(index);	
				}
				
				var filename = getFilenameFromUrl(path);
				if (filename === false) return reply(Boom.notFound());
				
				// in lazy mode, rebuild on bundle request
				if (options.lazy && (!options.filename || options.filename.test(filename)))
					rebuild();

				// delay the request until we have a vaild bundle
				ready(function () {
					try {
						var stat = fs.statSync(filename);
						if (!stat.isFile()) {
							if (stat.isDirectory()) {
								filename = path.join(filename, "index.html");
								stat = fs.statSync(filename);
								if (!stat.isFile()) throw "next";
							} else {
								throw "next";
							}
						}
					} catch (e) {
						return reply(Boom.notFound());
					}

					// server content
					var content = fs.readFileSync(filename);
					var response = reply(content).hold();
					response.header("Access-Control-Allow-Origin", "*");
					response.type(mime.lookup(filename));
					response.bytes(content.length);
					if (options.headers) {
						for (var name in options.headers) {
							response.header(name, options.headers[name]);
						}
					}
					response.send();
				}, request.raw.req);
			}
		});
		
		next();
	}
	
	// webpackDevPlugin.getFilenameFromUrl = getFilenameFromUrl;

	// webpackDevPlugin.invalidate = function () {
	// 	if (watching) watching.invalidate();
	// };
	// webpackDevPlugin.close = function (callback) {
	// 	callback = callback || function () { };
	// 	if (watching) watching.close(callback);
	// 	else callback();
	// };

	// webpackDevPlugin.fileSystem = fs;
	
	webpackDevPlugin.attributes = {
		pkg: require('./package.json')
	}

	return webpackDevPlugin;
}