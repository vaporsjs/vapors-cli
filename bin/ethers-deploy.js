#!/usr/bin/env node

'use strict';

var fs = require('fs');
var pathlib = require('path');
var util = require('util');
var zlib = require('zlib');

var abs = require('abs');
var ethers = require('ethers');

var Git = require('../lib/git');

var api = require('../lib/api');
var builders = require('../lib/builders');
var compiler = require('../lib/compiler');
var getopts = require('../lib/getopts');
var WebServer = require('../lib/webserver');

var version = require('../package.json').version;

var DefaultAccountFilename = './account.json';

var options = {
    help: false,
    version: false,

    optimize: false,
    contract: '',
    args: '',
    bytecode: false,
    interface: false,
    solc: false,

    host: '127.0.0.1',
    port: 8080,

    _accounts: true,
    _defaultAccount: DefaultAccountFilename,
    _provider: true,
    _promises: true,
};

function getGitContent(gitTag, root) {
    var git = new Git(root);

    var revPromise = Promise.resolve(gitTag);
    if (gitTag.toLowerCase() === 'head') {
        revPromise = git.getHead();
    }

    return revPromise.then(function(rev) {
       return git.listTree(rev).then(function(tree) {
           var content = {};
           var seq = Promise.resolve();

           Object.keys(tree).forEach(function(filename) {
               var hash = tree[filename];
               seq = seq.then(function() {
                  return git.show(['.', filename].join(pathlib.sep), rev).then(function(data) {
                      content[filename] = {
                          hash: hash,
                          data: data.toString('base64')
                      };
                  });
               });
           });

           return seq.then(function() {
               return {
                   content: content,
                   tag: rev,
               }
           });
       });
    });
}

function doCompile(filename, optimize, name, formats) {
    try {
        var output = compiler.compile(filename, options.optimize, true);
    } catch (error) {
        if (error.errors) {
           error.errors.forEach(function(error) {
                console.log('Error: ' + error.filename + ':' + error.row + ':' + error.column + ': ' + error.message);
                if (error.code) {
                    error.code.split('\n').forEach(function(line) {
                        console.log('    ' + line);
                    });
                }
            });
            getopts.throwError('compilation failed');
        }
        throw error;
    }

    if (name) {
        output = output[name];;

    } else {
        var names = Object.keys(output);
        if (names.length > 1) {
            throw new Error('must choose a contract: ', names.join(', '));
        } else if (names.length === 0) {
            throw new Error('no contract found');
        }
        output = output[names[0]];
    }

    if (Object.keys(formats).length === 1) {
        if (formats.bytecode) { return output.bytecode; }
        if (formats.interface) { return JSON.stringify(output.interface, null, '    '); }
        if (formats.solc) { JSON.stringify(output._solc); }
    }

    var result = {};

    if (formats.bytecode) { result.bytecode = output.bytecode; }
    if (formats.interface) { result.interface = output.interface; }
    if (formats.solc) { result.interface = output._solc; }

    return JSON.stringify(result, null, '    ');
}

function doDeploy(provider, accounts, deploy, options) {
    var builder = new builders.Builder(provider, accounts, deploy);
    return builder.deploy();
}

function doPublish(slugData) {
    return api.putSlug(null, slugData);
}

function doServe(provider, host, port, gitTag, path) {

    var handler = null;
    if (gitTag) {
        var gitContentPromise = getGitContent(gitTag, path);
        handler = function(path) {
            path = path.substring(1);
            console.log('PATH', path);
            return gitContentPromise.then(function(info) {
                var content = info.content[path];
                if (!content) {
                    content = info.content[path + '/index.html'];
                    if (!content) {
                        throw WebServer.makeError(404, 'Not Found');
                    }
                }
                return {
                    body: new Buffer(content.data, 'base64'),
                    path: ('git:' + info.tag + '/' + path)
                }
            });
        }
    } else {
        var rootPath = undefined;
        if (path) {
            rootPath = pathlib.resolve(process.cwd(), path);
        }
        handler = WebServer.staticFileHandler(rootPath);
    }

    var webServer = new WebServer(handler, { host: host, port: port });

    webServer.addOverride(DefaultAccountFilename, WebServer.makeError(403, 'Forbidden'));

    webServer.start(function() {
        var path = '/#!/app-link-insecure/localhost:' + webServer.port + '/';

        console.log('Listening on port: ' + webServer.port);
        console.log('Local Application Test URL:');
        console.log('  mainnet: http://ethers.io' + path);
        console.log('  ropsten: http://ropsten.ethers.io' + path);
        console.log('  rinkeby: http://rinkeby.ethers.io' + path);
        console.log('  kovan:   http://kovan.ethers.io' + path);
    });

    return new Promise(function(resolve, reject) {
        // @TODO: Make this resolve whent he server shuts down
    });
}

getopts(options).then(function(opts) {

    // Check command line options make sense

    if (opts.options.help) { getopts.throwError(); }

    if (opts.options.version) {
        console.log('ethers-build/' + version);
        return function() { }
    }

    if (opts.args.length === 0) {
        getopts.throwError('no command specified');
    }

    var command = opts.args.shift();

    switch (command) {
        case 'compile': return (function() {
            if (opts.args.length !== 1) { getopts.throwError('deploy requires FILENAME_SOL'); }

            var formats = {};
            if (opts.options.bytecode) { formats.bytecode = true; }
            if (opts.options.interface) { formats.interface = true; }
            if (opts.options.solc) { formats.solc = true; }
            if (Object.keys(formats).length === 0) { formats = { bytecode: true, interface: true } };

            return (function() {
                var output = doCompile(opts.args[0], opts.options.optimize, (opts.options.contract || null), formats);
                console.log(output);
                return Promise.resolve(output);
            });
        })();

        case 'deploy': return (function() {
            if (opts.args.length !== 1) { getopts.throwError('deploy requires FILENAME_SOL'); }
            var filename = opts.args.shift();

            var deployFunc = function(builder) {
                var codes = builder.compile(filename, true);
                var codeNames = Object.keys(codes);
                if (codeNames.length === 0) {
                    getopts.throwError('no contracts found');

                } else if (codeNames.length === 1) {
                    var code = codes[codeNames[0]];

                } else if (codeNames.length > 1) {
                    if (!opts.options.contract) {
                        getopts.throwError('multiple contract found; [ ' + codeNames.join(', ') + ' ]; use --contract NAME');
                    }
                    var code = codes[opts.options.contract];
                    if (!code) {
                        getopts.throwError('contract not found; ' + opts.options.contract);
                    }
                }

                var args = [];
                if (opts.options.args) {
                    args = JSON.parse(opts.options.args);
                }

                return code.deploy.apply(code, args);
            }

            if (opts.explicit.data) { getopts.throwError('unknown option: --data'); }

            return (function() {
                return doDeploy(opts.provider, opts.accounts, deployFunc, options);
            });
        })();

        case 'run': return (function() {
            if (opts.args.length !== 1) { getopts.throwError('deploy requires FILENAME_JS'); }
            var filename = opts.args.shift();

            try {
                var deployFunc = require(pathlib.resolve(filename));
            } catch (error) {
                console.log(error);
                getopts.throwError('cannot load ' + filename);
            }

            if (opts.explicit.data) { getopts.throwError('unknown option: --data'); }
            if (opts.explicit.value) { getopts.throwError('unknown option: --value'); }

            return (function() {
                return doDeploy(opts.provider, opts.accounts, deployFunc, options);
            });
        })();

        case 'init': return (function() {
            var filename = DefaultAccountFilename;
            if (opts.args.length > 0) { filename = opts.args.shift(); }
            if (opts.args.length > 0) { getopts.throwError('too many arguments'); }

            return (function() {
                if (fs.existsSync(filename)) {
                    getopts.throwError('Account already exists (' + filename + ').');
                }

                var account = ethers.Wallet.createRandom();

                console.log('Do NOT lose or forget this password. It cannot be reset.');
                var password = getopts.getPassword('New Account Password: ');
                var confirmPassword = getopts.getPassword('Confirm Password: ');
                if (Buffer.compare(password, confirmPassword) !== 0) {
                    getopts.throwError('Passwords did NOT match. Aborting.');
                }

                console.log('Encrypting Account... (this may take a few seconds)');
                return account.encrypt(password).then(function(json) {
                    try {
                        fs.writeFileSync(filename, json, {flag: 'wx'});
                        console.log('Account successfully created. Keep this file SAFE. Do NOT check it into source control');
                    } catch (error) {
                        getopts.throwError('Error saving account.js: ' + error.message);
                    }
                }, function(error) {
                    getopts.throwError('Error encrypting account: ' + error.message);
                });
            });
        })();

        case 'publish': return (function() {
            if (opts.accounts.length != 1) { getopts.throwError('publish requires an account'); }

            var tag = 'HEAD', path = '.';
            if (opts.args.length > 0) { tag = opts.args.shift(); }
            if (opts.args.length > 0) { path = opts.args.shift(); }
            if (opts.args.length > 0) { getopts.throwError('too many arguments'); }

            return (function() {
                return api.getPublished(opts.accounts[0].address).then(function(published) {
                    return getGitContent(tag, abs(path)).then(function(info) {
                        console.log('');
                        var contentData = JSON.stringify({
                            address: opts.accounts[0].address,
                            content: info.content,
                            tag: info.tag,
                            nonce: published.nonce + 1,
                            version: 2
                        });
                        var signature = opts.accounts[0].signMessage(contentData);
                        var pubdata = JSON.stringify({
                            content: zlib.gzipSync(contentData).toString('base64'),
                            signature: signature
                        });
                        return api.publish(pubdata).then(function(success) {
                            var host = opts.accounts[0].address.toLowerCase() + '.ethers.space/';
                            console.log('');
                            console.log('Successfully deployed!');
                            console.log('');
                            console.log('Application URLs:');
                            console.log('  Mainnet:  https://ethers.io/#!/app-link/' + host);
                            console.log('  Ropsten:  https://ropsten.ethers.io/#!/app-link/' + host);
                            console.log('  Rinkebey: https://rinkeby.ethers.io/#!/app-link/' + host);
                            console.log('  Kovan:    https://kovan.ethers.io/#!/app-link/' + host);
                            console.log('');
                        });
                    });
                });
            });
        })();

        case 'serve': return (function() {
            var tag = null, path = '.';
            if (opts.args.length > 0) {
                tag = opts.args.shift();
                if (tag === 'null') { tag = null; }
            }
            if (opts.args.length > 0) { path = opts.args.shift(); }
            return (function() {
                return doServe(opts.provider, opts.options.host, opts.options.port, tag, path);
            });
        })();

        case 'status': return (function() {
            var filename = DefaultAccountFilename;
            if (opts.args.length > 0) { filename = opts.args.shift(); }
            try {
                var address = ethers.utils.getAddress(JSON.parse(fs.readFileSync(filename).toString()).address);
            } catch (error) {
                console.log(error);
                getopts.throwError('invalid JSON wallet - ' + filename);
            }

            return (function() {
                return api.getPublished(address).then(function(published) {
                    var host = address.toLowerCase() + '.ethers.space/';

                    console.log('');
                    console.log('Status:');
                    console.log('  Address:   ' + address);
                    console.log('  Nonce:     ' + published.nonce);
                    console.log('  Git Tag:   ' + published.tag);
                    console.log('  Raw URL:   https://' + host);
                    console.log('');
                    console.log('Application URLs:');
                    console.log('  Mainnet:  https://ethers.io/#!/app-link/' + host);
                    console.log('  Ropsten:  https://ropsten.ethers.io/#!/app-link/' + host);
                    console.log('  Rinkebey: https://rinkeby.ethers.io/#!/app-link/' + host);
                    console.log('  Kovan:    https://kovan.ethers.io/#!/app-link/' + host);
                    console.log('');
                });
            });
        })();

        default:
            getopts.throwError('unknown command; ' + command);
    }

}).then(function(run) {
    return run();

}, function(error) {
    console.log('');
    console.log('Command Line Interface - ethers-build/' + version);
    console.log('');
    console.log('Usage:');
    console.log('');
    console.log('    ethers-build compile FILENAME [ Compiler Options ] [ --optimize ]');
    console.log('');
    console.log('    ethers-build run FILENAME_JS [ Node + Account + Tx Options ]');
    console.log('    ethers-build deploy FILENAME_SOL [ Node + Account + Tx Options ]');
    console.log('');
    console.log('    ethers-build serve [ GIT_TAG ] [ --host HOST ] [ --port PORT ] [ Node Options ]');
    console.log('');
    console.log('    ethers-build init');
    console.log('    ethers-build publish [ GIT_TAG [ PATH ] ]');
    console.log('    ethers-build status [ ACCOUNT ]');
    console.log('');
    console.log('Compile Options');
    console.log('  --bytecode            Only output bytecode');
    console.log('  --interface           Only output the JSON interface');
    console.log('  --solc                Output the entire solc output');
    console.log('  --optimize            Run the optimizer');
    console.log('');
    console.log('Node Options');
    console.log('  --testnet             Use "ropsten" configuration (deprecated)');
    console.log('  --network NETWORK     Use NETWORK configuration (default: homestead)');
    console.log('  --rpc URL             Use the Ethereum node at URL');
    console.log('');
    console.log('Account Options');
    console.log('  --account FILENAME    Use the JSON wallet');
    //console.log('  --private-key KEY     Use the private key (use - for secure entry)');
    //console.log('  --mnemonic PHRASE     Use the mneonic (use - for secure entry)');
    console.log('');
    console.log('Transaction Options');
    console.log('  --gas-price GWEI      Override the gas price');
    console.log('  --gas-limit LIMIT     Override the gas limit');
    console.log('  --nonce NONCE         Override the nonce (.sol only)');
    console.log('  --value ETHER         Send ether (.sol only)');
    console.log('');
    console.log('Options');
    console.log('  --help                Show this help');
    console.log('  --version             Show the version');

    if (error.message) { throw error; }
    console.log('');

}).catch(function(error) {
    console.log('');
    if (!error._messageOnly) {
        console.log(error.stack);
    } else {
        console.log('Error: ' + error.message);
    }
    console.log('');
});