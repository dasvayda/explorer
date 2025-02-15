var mongoose = require('mongoose')
  , Stats = require('../models/stats')
  , Markets = require('../models/markets')
  , Address = require('../models/address')
  , Tx = require('../models/tx')
  , Richlist = require('../models/richlist')
  , Peers = require('../models/peers')
  , Heavy = require('../models/heavy')
  , lib = require('./explorer')
  , settings = require('./settings')
  , poloniex = require('./markets/poloniex')
  , bittrex = require('./markets/bittrex')
  , bleutrade = require('./markets/bleutrade')
  , cryptsy = require('./markets/cryptsy')
  , cryptopia = require('./markets/cryptopia')
  , yobit = require('./markets/yobit')
  , empoex = require('./markets/empoex')
  , ccex = require('./markets/ccex')
  , request = require('request')
  , $as = require('futoin-asyncsteps');
//  , BTC38 = require('./markets/BTC38');

function find_address(hash, cb) {
  Address.findOne({a_id: hash}, function(err, address) {
    if(address) {
      return cb(address);
    } else {
      return cb();
    }
  });
}

function find_richlist(coin, cb) {
  Richlist.findOne({coin: coin}, function(err, richlist) {
    if(richlist) {
      return cb(richlist);
    } else {
      return cb();
    }
  });
}

function update_address(hash, txid, amount, type, undo, cb) {
  // Check if address exists
  find_address(hash, function(address) {
    if (address) {
      if (undo) {
        amount = -amount;
      }

      // if coinbase (new coins PoW), update sent only and return cb.
      if ( hash === 'coinbase' ) {
        return cb();
      } else {
        // ensure tx doesnt already exist in address.txs
        lib.is_unique(address.txs, txid, function(unique, index) {
          var tx_array = address.txs;
          var received = address.received;
          var sent = address.sent;
          if (type == 'vin') {
            sent = sent + amount;
          } else {
            received = received + amount;
          }
          if (unique == true) {
            if (undo) {
                // NOTE: it is still possible to get incorrect balances due to
                // transaction cache limit. So, periodic balance recalculation is required.
                return cb();
            }

            tx_array.push({addresses: txid, type: type});
            if ( tx_array.length > settings.txcount ) {
              tx_array.shift();
            }
            Address.update({a_id:hash}, {
              txs: tx_array,
              received: received,
              sent: sent,
              balance: received - sent
            }, function() {
              return cb();
            });
          } else if (undo) {
              if (type == tx_array[index].type) {
                  tx_array.splice(index, 1);
              } else if ('both' === tx_array[index].type) {
                  tx_array[index].type = (type == 'vin') ? 'vout' : 'vin';
              } else {
                  // See the NOTE above
                  // already removed
                  return cb();
              }

              Address.update({a_id:hash}, {
                txs: tx_array,
                received: received,
                sent: sent,
                balance: received - sent
              }, function() {
                return cb();
              });
          } else {
            if (type == tx_array[index].type) {
              return cb(); //duplicate
            } else {
              tx_array[index].type = 'both';

              Address.update({a_id:hash}, {
                txs: tx_array,
                received: received,
                sent: sent,
                balance: received - sent
              }, function() {
                return cb();
              });
            }
          }
        });
      }
    } else if (undo) {
        // No even created, possible abort
        return cb();
    } else {
      //new address
      if (type == 'vin') {
        var newAddress = new Address({
          a_id: hash,
          txs: [ {addresses: txid, type: 'vin'} ],
          sent: amount,
          balance: amount,
        });
      } else {
        var newAddress = new Address({
          a_id: hash,
          txs: [ {addresses: txid, type: 'vout'} ],
          received: amount,
          balance: amount,
        });
      }

      newAddress.save(function(err) {
        if (err) {
          return cb(err);
        } else {
          //console.log('address saved: %s', hash);
          //console.log(newAddress);
          return cb();
        }
      });
    }
  });
}

function find_tx(txid, cb) {
  Tx.findOne({txid: txid}, function(err, tx) {
    if(tx) {
      return cb(tx);
    } else {
      return cb(null);
    }
  });
}

function save_tx(txid, undo, cb) {
  //var s_timer = new Date().getTime();
  lib.get_rawtransaction(txid, function(tx){
    if (tx && tx != 'There was an error. Check your console.') {
      lib.get_block(tx.blockhash, function(block){
        if (block) {
          lib.prepare_vin(tx, function(vin) {
            lib.prepare_vout(tx.vout, txid, vin, function(vout, nvin) {
                const process_vinout = () => {
                    lib.syncLoop(vin.length, function (loop) {
                        var i = loop.iteration();
                        update_address(nvin[i].addresses, txid, nvin[i].amount, 'vin', undo, function(){
                            loop.next();
                        });
                    }, function(){
                        lib.syncLoop(vout.length, function (subloop) {
                            var t = subloop.iteration();
                            if (vout[t].addresses) {
                                update_address(vout[t].addresses, txid, vout[t].amount, 'vout', undo, function(){
                                    subloop.next();
                                });
                            } else {
                                    subloop.next();
                            }
                        }, function(){
                            return cb();
                        });
                    });
                };

                if (undo) {
                    return process_vinout();
                } else {
                    lib.calculate_total(vout, function(total){
                        var newTx = new Tx({
                            txid: tx.txid,
                            vin: nvin,
                            vout: vout,
                            total: total.toFixed(8),
                            timestamp: tx.time,
                            blockhash: tx.blockhash,
                            blockindex: block.height,
                        });

                        newTx.save(function(err) {
                            if (err) {
                                console.log(err);
                                process.exit(1);
                            } else {
                                //console.log('txid: ');
                                return process_vinout();
                            }
                        });
                    });
                }
            });
          });
        } else {
          return cb('block not found: ' + tx.blockhash);
        }
      });
    } else {
      return cb('tx not found: ' + txid);
    }
  });
}

function get_market_data(market, cb) {
  switch(market) {
    case 'bittrex':
      bittrex.get_data(settings.markets.coin, settings.markets.exchange, function(err, obj){
        return cb(err, obj);
      });
      break;
    case 'bleutrade':
      bleutrade.get_data(settings.markets.coin, settings.markets.exchange, function(err, obj){
        return cb(err, obj);
      });
      break;
    case 'poloniex':
      poloniex.get_data(settings.markets.coin, settings.markets.exchange, function(err, obj){
        return cb(err, obj);
      });
      break;
    case 'cryptsy':
      cryptsy.get_data(settings.markets.coin, settings.markets.exchange, settings.markets.cryptsy_id, function(err, obj){
        return cb(err, obj);
      });
      break;
    case 'cryptopia':
      cryptopia.get_data(settings.markets.coin, settings.markets.exchange, settings.markets.cryptopia_id, function (err, obj) {
        return cb(err, obj);
      });
      break;
    case 'ccex':
      ccex.get_data(settings.markets.coin.toLowerCase(), settings.markets.exchange.toLowerCase(), settings.markets.ccex_key, function (err, obj) {
        return cb(err, obj);
      });
      break;
    case 'yobit':
      yobit.get_data(settings.markets.coin.toLowerCase(), settings.markets.exchange.toLowerCase(), function(err, obj){
        return cb(err, obj);
      });
      break;
    case 'empoex':
      empoex.get_data(settings.markets.coin, settings.markets.exchange, function(err, obj){
        return cb(err, obj);
      });
      break;
    default:
      return cb(null);
  }
}

module.exports = {
  // initialize DB
  connect: function(database, cb) {
    mongoose.connect(database, function(err) {
      if (err) {
        console.log('Unable to connect to database: %s', database);
        console.log('Aborting');
        process.exit(1);

      }
      //console.log('Successfully connected to MongoDB');
      return cb();
    });
  },

  check_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
        return cb(stats);
      } else {
        return cb(null);
      }
    });
  },

  create_stats: function(coin, cb) {
    var newStats = new Stats({
      coin: coin,
    });

    newStats.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial stats entry created for %s", coin);
        //console.log(newStats);
        return cb();
      }
    });
  },

  get_address: function(hash, cb) {
    find_address(hash, function(address){
      return cb(address);
    });
  },

  get_richlist: function(coin, cb) {
    find_richlist(coin, function(richlist){
      return cb(richlist);
    });
  },
  //property: 'received' or 'balance'
  update_richlist: function(list, cb){
    if(list == 'received') {
      Address.find({}).sort({received: 'desc'}).limit(100).exec(function(err, addresses){
        Richlist.update({coin: settings.coin}, {
          received: addresses,
        }, function() {
          return cb();
        });
      });
    } else { //balance
      Address.find({}).sort({balance: 'desc'}).limit(100).exec(function(err, addresses){
        Richlist.update({coin: settings.coin}, {
          balance: addresses,
        }, function() {
          return cb();
        });
      });
    }
  },

  get_tx: function(txid, cb) {
    find_tx(txid, function(tx){
      return cb(tx);
    });
  },

  get_txs: function(block, cb) {
    var txs = [];
    lib.syncLoop(block.tx.length, function (loop) {
      var i = loop.iteration();
      find_tx(block.tx[i], function(tx){
        if (tx) {
          txs.push(tx);
          loop.next();
        } else {
          loop.next();
        }
      })
    }, function(){
      return cb(txs);
    });
  },

  get_last_txs: function(count, min, cb) {
    Tx.find({'total': {$gt: min}}).sort({_id: 'desc'}).limit(count).exec(function(err, txs){
      if (err) {
        return cb(err);
      } else {
        return cb(txs);
      }
    });
  },

  create_market: function(coin, exchange, market, cb) {
    var newMarkets = new Markets({
      market: market,
      coin: coin,
      exchange: exchange,
    });

    newMarkets.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial markets entry created for %s", market);
        //console.log(newMarkets);
        return cb();
      }
    });
  },

  // checks market data exists for given market
  check_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, exists) {
      if(exists) {
        return cb(market, true);
      } else {
        return cb(market, false);
      }
    });
  },

  // gets market data for given market
  get_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, data) {
      if(data) {
        return cb(data);
      } else {
        return cb(null);
      }
    });
  },

  // creates initial richlist entry in database; called on first launch of explorer
  create_richlist: function(coin, cb) {
    var newRichlist = new Richlist({
      coin: coin,
    });
    newRichlist.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial richlist entry created for %s", coin);
        //console.log(newRichlist);
        return cb();
      }
    });
  },
  // checks richlist data exists for given coin
  check_richlist: function(coin, cb) {
    Richlist.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  create_heavy: function(coin, cb) {
    var newHeavy = new Heavy({
      coin: coin,
    });
    newHeavy.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial heavy entry created for %s", coin);
        console.log(newHeavy);
        return cb();
      }
    });
  },

  check_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, heavy) {
      if(heavy) {
        return cb(heavy);
      } else {
        return cb(null);
      }
    });
  },
  get_distribution: function(richlist, stats, cb){
    var distribution = {
      supply: stats.supply,
      t_1_25: {percent: 0, total: 0 },
      t_26_50: {percent: 0, total: 0 },
      t_51_75: {percent: 0, total: 0 },
      t_76_100: {percent: 0, total: 0 },
      t_101plus: {percent: 0, total: 0 }
    };
    lib.syncLoop(richlist.balance.length, function (loop) {
      var i = loop.iteration();
      var count = i + 1;
      var percentage = ((richlist.balance[i].balance / 100000000) / stats.supply) * 100;
      if (count <= 25 ) {
        distribution.t_1_25.percent = distribution.t_1_25.percent + percentage;
        distribution.t_1_25.total = distribution.t_1_25.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 50 && count > 25) {
        distribution.t_26_50.percent = distribution.t_26_50.percent + percentage;
        distribution.t_26_50.total = distribution.t_26_50.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 75 && count > 50) {
        distribution.t_51_75.percent = distribution.t_51_75.percent + percentage;
        distribution.t_51_75.total = distribution.t_51_75.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 100 && count > 75) {
        distribution.t_76_100.percent = distribution.t_76_100.percent + percentage;
        distribution.t_76_100.total = distribution.t_76_100.total + (richlist.balance[i].balance / 100000000);
      }
      loop.next();
    }, function(){
      distribution.t_101plus.percent = parseFloat(100 - distribution.t_76_100.percent - distribution.t_51_75.percent - distribution.t_26_50.percent - distribution.t_1_25.percent).toFixed(2);
      distribution.t_101plus.total = parseFloat(distribution.supply - distribution.t_76_100.total - distribution.t_51_75.total - distribution.t_26_50.total - distribution.t_1_25.total).toFixed(8);
      distribution.t_1_25.percent = parseFloat(distribution.t_1_25.percent).toFixed(2);
      distribution.t_1_25.total = parseFloat(distribution.t_1_25.total).toFixed(8);
      distribution.t_26_50.percent = parseFloat(distribution.t_26_50.percent).toFixed(2);
      distribution.t_26_50.total = parseFloat(distribution.t_26_50.total).toFixed(8);
      distribution.t_51_75.percent = parseFloat(distribution.t_51_75.percent).toFixed(2);
      distribution.t_51_75.total = parseFloat(distribution.t_51_75.total).toFixed(8);
      distribution.t_76_100.percent = parseFloat(distribution.t_76_100.percent).toFixed(2);
      distribution.t_76_100.total = parseFloat(distribution.t_76_100.total).toFixed(8);
      return cb(distribution);
    });
  },
  // updates heavy stats for coin
  // height: current block height, count: amount of votes to store
  update_heavy: function(coin, height, count, cb) {
    var newVotes = [];
    lib.get_maxmoney( function (maxmoney) {
      lib.get_maxvote( function (maxvote) {
        lib.get_vote( function (vote) {
          lib.get_phase( function (phase) {
            lib.get_reward( function (reward) {
              lib.get_supply( function (supply) {
                lib.get_estnext( function (estnext) {
                  lib.get_nextin( function (nextin) {
                    lib.syncLoop(count, function (loop) {
                      var i = loop.iteration();
                      lib.get_blockhash(height-i, function (hash) {
                        lib.get_block(hash, function (block) {
                          newVotes.push({count:height-i,reward:block.reward,vote:block.vote});
                          loop.next();
                        });
                      });
                    }, function(){
                      console.log(newVotes);
                      Heavy.update({coin: coin}, {
                        lvote: vote,
                        reward: reward,
                        supply: supply,
                        cap: maxmoney,
                        estnext: estnext,
                        phase: phase,
                        maxvote: maxvote,
                        nextin: nextin,
                        votes: newVotes,
                      }, function() {
                        //console.log('address updated: %s', hash);
                        return cb();
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  },

  // updates market data for given market; called by sync.js
  update_markets_db: function(market, cb) {
    // get_market_data(market, function (err, obj) {
    //   if (err == null) {
    //     Markets.update({market:market}, {
    //       chartdata: JSON.stringify(obj.chartdata),
    //       buys: obj.buys,
    //       sells: obj.sells,
    //       history: obj.trades,
    //       summary: obj.stats,
    //     }, function() {
          // if ( market == settings.markets.default ) {
            var cmcUrl = "https://api.coinmarketcap.com/v1/ticker/energi/";
            var price_btc = 0;
            request(cmcUrl, function(e, response, body) {
                if (e) {
                    console.log(e)
                }
                const json = JSON.parse(body);
                price_btc = json[0].price_btc
                Stats.update({coin:settings.coin}, {
                  last_price: price_btc,
                }, function(){
                  return cb(null);
                });
            });

            
          // } else {
            // return cb(null);
          // }
    //     });
    //   } else {
    //     return cb(err);
    //   }
    // });
  },

  // updates stats data for given coin; called by sync.js
  update_db: function(coin, cb) {
    lib.get_blockcount( function (count) {
      if (!count){
        console.log('Unable to connect to explorer API');
        return cb(false);
      }
      lib.get_supply( function (supply){
        lib.get_connectioncount(function (connections) {
          Stats.update({coin: coin}, {
            coin: coin,
            count : count,
            supply: supply,
            connections: connections,
          }, function() {
            return cb(true);
          });
        });
      });
    });
  },

  // updates tx, address & richlist db's; called by sync.js
  update_tx_db: function(coin, start, end, timeout, cb) {
    let height = start;

    $as()
      // Check Orphans
      .loop((asi) => {
          if (height <= 1) {
              if (height != start) {
                console.log('Genesis is reached during orphan search!');
              }
              asi.break();
          }

          Tx.aggregate([
            { $match: {
                blockindex: height,
            } },
            { $group : {
              _id: '$blockhash',
            } },
          ]).exec((err, res) => {
            if (err) {
              console.log(err);
              process.exit(1);
            }

            if (res.length === 1) {
              lib.get_blockhash(height, function(blockhash){
                if (blockhash === res[0]._id) {
                  if (height < start) {
                      ++height;
                  }
                  try {
                    asi.break();
                  } catch (e) {}
                } else {
                  console.log(`Found orphan block at ${height}: ${blockhash} != ${res[0]._id}`);
                  --height;
                  --start;
                  asi.success();
                }
              });
            } else {
              if (res.length > 1) {
                console.log(`More blocks per height: ${JSON.stringify(res)}`);
              }

              --height;
              asi.success();
            }
          });
          asi.waitExternal();
      })
      // Cleanup of TXs
      .add((asi) => {
        // Find orphans TXs
        asi.add((asi) => {
            Tx.find({blockindex: { $gte: height }}, null, { sort: {blockindex: -1}}, function(err, txs) {
              if (err) {
                console.log(err);
                process.exit(1);
              } else {
                asi.success(txs);
              }
            });
            asi.waitExternal();
        })
        // UNDO TXs, if any
        .add((asi, txs) => {
            asi.forEach(txs, (asi, _, tx) => {
                console.log(`Undoing TX: ${tx.txid}`);

                save_tx(tx.txid, true, function(err){
                  if (err) {
                    console.log(err);
                    process.exit(1);
                  } else {
                    console.log('UNDO %s: %s', tx.blockindex, tx);
                    asi.success();
                  }
                });
                asi.waitExternal();
            });
        })
        // Cleanup of TXs
        .add((asi) => {
          Tx.remove({blockindex: { $gte: height }}, function(err) {
            if (err) {
              console.log(err);
              process.exit(1);
            } else {
              asi.success();
            }
          });
          asi.waitExternal();
        })
      })
      // Do block update
      .add((asi) => {
        this.update_tx_db_inner(coin, height, end, timeout, cb);
      })
      .execute();
  },

  update_tx_db_inner: function(coin, start, end, timeout, cb) {
    var complete = false;
    lib.syncLoop((end - start) + 1, function (loop) {
      const height = start + loop.iteration();
      lib.get_blockhash(height, function(blockhash){
        if (blockhash) {
          lib.get_block(blockhash, function(block) {
            if (block) {
              lib.syncLoop(block.tx.length, function (subloop) {
                const tx = block.tx[subloop.iteration()];
                save_tx(tx, false, function(err){
                  if (err) {
                    console.log(err);
                    process.exit(1);
                  } else {
                    console.log('%s: %s', height, tx);
                    subloop.next();
                  }
                });
              }, () => {
                Stats.update({coin: coin}, {
                    last: height,
                    last_txs: '' //not used anymore left to clear out existing objects
                }, function(err) {
                  if (err) {
                    console.log(err);
                    process.exit(1);
                  } else {
                    loop.next();
                  }
                });
              });
            } else {
              console.log('block not found: %s', blockhash);
              loop.next();
            }
          });
        } else {
          console.log(`Failed to get block hash at height ${height}`);
          process.exit(1);
        }
      });
    }, function(){
      return cb();
    });
  },

  create_peer: function(params, cb) {
    var newPeer = new Peers(params);
    newPeer.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  find_peer: function(address, cb) {
    Peers.findOne({address: address}, function(err, peer) {
      if (err) {
        return cb(null);
      } else {
        if (peer) {
         return cb(peer);
       } else {
         return cb (null)
       }
      }
    })
  },

  get_peers: function(cb) {
    Peers.find({}, function(err, peers) {
      if (err) {
        return cb([]);
      } else {
        return cb(peers);
      }
    });
  }
};
