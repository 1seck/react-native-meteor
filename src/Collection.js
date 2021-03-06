/* eslint-disable */
import Tracker from 'trackr';
import EJSON from 'ejson';

import Data from './Data';
import Random from './lib/Random';
import call from './Call';
import { isPlainObject } from "./lib/utils";

class Cursor {
  constructor(collection, docs) {
    this._docs = docs || [ ];
    this._collection = collection;
  }

  count() { return this._docs.length }

  fetch() { return this._transformedDocs() }

  forEach(callback) { this._transformedDocs().forEach(callback) }

  map(callback) { return this._transformedDocs().map(callback) }

  _transformedDocs() {
    return this._collection._transform ? this._docs.map(this._collection._transform) : this._docs;
  }
}

export class Collection {
  constructor(name, options = { }) {
    if (!Data.db[name]) Data.db.addCollection(name);

    this._collection = Data.db[name];
    this._name = name;
    this._transform = wrapTransform(options.transform);
  }

  find(selector, options) {
    let result;
    let docs;

    if(!selector) selector = {}

    if(typeof selector === 'string') {
      selector = { _id: selector }
    }

    if(selector._id) {
      if(options) {
        docs = this._collection.findOne(selector, options);
      } else {
        docs = this._collection.get(selector._id);
      }
      if (docs) {
        docs = [this.transform ? this._transform(docs): docs];
      }
    } else {
      docs = this._collection.find(selector, options);
    }

    return new Cursor(this, docs);;
  }

  findOne(selector, options) {
    let result = this.find(selector, options);

    if (result) {
      result = result.fetch()[0];
    }

    return result;
  }

  insert(item, callback = ()=>{}) {
    let id;
    
    console.log("insert", JSON.stringify(item, null, 2))
    if('_id' in item) {
      if(!item._id || typeof item._id != 'string') {
        return callback("Meteor requires document _id fields to be non-empty strings");
      }
      id = item._id;
    } else {
      id = item._id = Random.id();
    }

    if(this._collection.get(id)) return callback({error: 409, reason: `Duplicate key _id with value ${id}`});

    this._collection.upsert(item);
    Data.waitDdpConnected(()=>{
      call(`/${this._name}/insert`, item, err => {
        if(err) {
          this._collection.del(id);
          return callback(err);
        }

        callback(null, id);
      });
    });

    return id;
  }

  update(id, modifier, options={}, callback=()=>{}) {
    console.log("update", id, JSON.stringify(modifier, null, 2))
    if(typeof options == 'function') {
      callback = options;
      options = {};
    }

    const element = this.findOne(id);

    if(!element) return callback({
      error: 409,
      reason: `Item not found in collection ${this._name} with id ${id}`
    });

    // change mini mongo for optimize UI changes
    this._collection.upsert({ _id: element._id, ...modifier.$set });

    Data.waitDdpConnected(()=>{
      call(`/${this._name}/update`, {_id: element._id}, modifier, err => {
        if(err) {
          return callback(err);
        }

        callback(null, id);
      });
    });
  }

  remove(id, callback = ()=>{}) {
    const element = this.findOne(id);

    if(element) {
      this._collection.del(element._id);

      Data.waitDdpConnected(()=>{
        call(`/${this._name}/remove`, {_id: element._id}, (err, res) => {
          if(err) {
            this._collection.upsert(element);
            return callback(err);
          }
          callback(null, res);
        });
      });
    } else {
      callback(`No document with _id : ${id}`);
    }
  }
}

//From Meteor core

// Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.
function wrapTransform(transform) {
  if (! transform)
    return null;

  // No need to doubly-wrap transforms.
  if (transform.__wrappedTransform__)
    return transform;

  var wrapped = function (doc) {
    if (doc._id) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error("can only transform documents with _id");
    }

    var id = doc._id;
    // XXX consider making tracker a weak dependency and checking Package.tracker here
    var transformed = Tracker.nonreactive(function () {
      return transform(doc);
    });

    if (!isPlainObject(transformed)) {
      throw new Error("transform must return object");
    }

    if (transformed._id) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error("transformed document can't have different _id");
      }
    } else {
      transformed._id = id;
    }
    return transformed;
  };
  wrapped.__wrappedTransform__ = true;
  return wrapped;
};
