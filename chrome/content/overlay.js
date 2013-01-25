/*
  bugmail extension for Thunderbird
    
    Copyright (C) 2008  Fabrice Desré

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

    Initial author is Fabrice Desré - fabrice.desre@gmail.com
*/

var CC = Components.classes;
var CI = Components.interfaces;
var CU = Components.utils;

///////////////////////////////////////////////////////////////////////////
// Helper object: log console
///////////////////////////////////////////////////////////////////////////

var console = {
    service: null,
    log: function(msg) {
        if (!console.service) {
            console.service = CC["@mozilla.org/consoleservice;1"]
                .getService(CI.nsIConsoleService);
        }
        console.service.logStringMessage(msg);
    }
};

///////////////////////////////////////////////////////////////////////////
// Main object: bugmail
///////////////////////////////////////////////////////////////////////////

var bugmail = {
    loading : false,
    req: null,
    engines : [],
    
    addEngine: function(engine) {
        bugmail.engines.push(engine);
    },
    
    getFromCache: function(uri) {
        var cacheService = CC["@mozilla.org/network/cache-service;1"].
            getService(CI.nsICacheService);
        var cacheSession = cacheService.createSession("bugmail", CI.nsICache.STORE_IN_MEMORY, true);
            
        try {
            var entry = cacheSession.openCacheEntry(uri, CI.nsICache.ACCESS_READ, true);
            var input = entry.openInputStream(0);
            var cache = new Object();
            cache.doc = null;
            cache.text = null;
            var parser = CC["@mozilla.org/xmlextras/domparser;1"].createInstance(CI.nsIDOMParser);
            try {
                var xml = parser.parseFromStream(input, "utf-8", input.available(), "text/xml");
                cache.doc = xml;
            } catch(e) {
                cacheSession = cacheService.createSession("bugmail", CI.nsICache.STORE_IN_MEMORY, false);
                entry = cacheSession.openCacheEntry(uri, CI.nsICache.ACCESS_READ, true);
                cache.text = entry.data.data;
            }
            return cache;
        } catch(e) {
            return null;
        }
    },
    
    storeInCache: function(uri, doc, text) {
        var cacheService = CC["@mozilla.org/network/cache-service;1"].
            getService(CI.nsICacheService);
        if (doc) {
            var cacheSession = cacheService.createSession("bugmail", CI.nsICache.STORE_IN_MEMORY, true);
            var entry = cacheSession.openCacheEntry(uri, CI.nsICache.ACCESS_WRITE, true);
            var output = entry.openOutputStream(0);
            var ser = CC["@mozilla.org/xmlextras/xmlserializer;1"].createInstance(CI.nsIDOMSerializer);
            ser.serializeToStream(doc, output, "utf-8");
        }
        else {
            var cacheSession = cacheService.createSession("bugmail", CI.nsICache.STORE_IN_MEMORY, false);
            var entry = cacheSession.openCacheEntry(uri, CI.nsICache.ACCESS_WRITE, true);
            var wrapper = CC["@mozilla.org/supports-cstring;1"].createInstance(CI.nsISupportsCString);
            wrapper.data = text;
            entry.cacheElement = wrapper;
        }
        entry.markValid;
        entry.close();
    },
    
    update: function(bypassCache, mailURI, headers) {
        var engine = null;
        var uri = null;

        for (var i = 0; i < bugmail.engines.length; i++) {
            if (bugmail.engines[i].isBug(mailURI, headers)) {
                uri = bugmail.engines[i].getBugURI(mailURI, headers);
                if (uri) {
                    engine = bugmail.engines[i];
                  break;
                }
            }
        }
        
        bugmail.update_using_engine(bypassCache, engine, uri);
    },

    // Ensure bug box is visible (remove collapsed attribute, relocate if needed)
    ensure_bug_box_is_visible: function() {
        var bugbox = document.getElementById("bugmail-box");
        bugbox.removeAttribute("collapsed");
        
        // In Conversation case and some multi-message cases #singlemessage
        // may be hidden, while #multimessage is displayed. In normal mode
        // #singlemessage is displayed.
        //
        // By default we are within #singlemessage. In such a case, we need
        // to relocate our box to the visible one. Or if we already moved and
        // now switch view, we must relocate back.
        //
        // Positioning: 
        // - in #singlemessage we are just after msgHeaderView, immediately inside #singlemessage, 
        //   as set in overlay.xul
        // - in #multimessage case we can't put eleement inside #multimessage as this
        //   is browser, not XUL element. Therefore we migrate up

        var multimsg = document.getElementById("multimessage");
        if(! multimsg) {
            // No conversations, nothing to do
            return;
        }
        var singlemsg = document.getElementById("singlemessage");
        
        // Checking whether we are in hidden container
        var parent = bugbox.parentNode;
        var relocation_needed = false;
        while(parent) {
            if(parent.hidden) {
                relocation_needed = true;
                break;
            }
            parent = parent.parentNode;
        }

        // Relocating
        if(relocation_needed) {
            if(multimsg.hidden) {
                console.log("bugmail: Relocating bugbox to singlemessage");
                singlemsg.insertAfter(bugbox, document.getElementById("msgHeaderView"));
            } else {
                console.log("bugmail: Relocating bugbox to (before) multimessage");
                var msgpanebox = document.getElementById("messagepanebox");
                msgpanebox.insertBefore(
                    bugbox, msgpanebox.firstChild);
                // multimsg.parent.insertBefore(bugbox, multimsg);
                // multimsg.insertBefore(bugbox, document.getElementById("messageList"));
            }
        } else {
            console.log("bugmail: No need to relocate bugbox, it is visible");
        }

    },

    // Load the bug using given bug engine and given extracted bug uri
    update_using_engine: function(bypassCache, engine, uri) {

        if (engine) {
            
            document.getElementById("bugmail-logo").setAttribute("src", engine.iconURL);
            
            if (bugmail.loading) {
                bugmail.req.abort();
                bugmail.loading = false;
            }
            
            if (!bypassCache) {
                var data = bugmail.getFromCache(uri);
                if (data) {
                    console.log("bugmail: Succesfully reloaded bug info from cache. Uri: " + uri + ", text: " + data.text);
                    bugmail.ensure_bug_box_is_visible();
                    var content = document.getElementById("bugmail-info");
                    while (content.lastChild) {
                        content.removeChild(content.lastChild);
                    }
                    engine.updateUI(data.doc, data.text);
                    return;
                }
            }
            
            bugmail.req = new XMLHttpRequest();
            console.log("bugmail: Attempting to load bug details from " + uri);
            bugmail.req.open("GET", uri);
            bugmail.req.onload = function() {
                console.log("bugmail: Got bug info reply. Lead: " + this.responseText.substring(0,300));
                if(this.responseXML) {
                    bugmail.loading = false;
                    document.getElementById("bugmail-throbber").setAttribute("collapsed", "true");
                    bugmail.storeInCache(uri, this.responseXML, this.responseText);
                    engine.updateUI(this.responseXML, this.responseText);
                } else {
                    console.log("bugmail: Obtained reply did not parse.");
                }
            }
            bugmail.req.onerror = function(e) {
                console.log("bugmail: Bug info loading failed. Status: " + e.target.status + ", text: " + this.responseText);
                bugmail.loading = false;
                document.getElementById("bugmail-throbber").setAttribute("collapsed", "true");
            }
            var content = document.getElementById("bugmail-info");
            while (content.lastChild) {
                content.removeChild(content.lastChild);
            }
            document.getElementById("bugmail-details").setAttribute("collapsed", "true");
            bugmail.ensure_bug_box_is_visible();
            document.getElementById("bugmail-box").removeAttribute("collapsed");
            document.getElementById("bugmail-throbber").removeAttribute("collapsed");
            bugmail.loading = true;
            bugmail.req.send(null);
        }
        else {
            console.log("bugmail: Removing bug panel as no bug is present");
            document.getElementById("bugmail-box").setAttribute("collapsed", "true");
        }
        
    },

    observe: function(aSubject, aTopic, aData) {
        // console.log("observe(" + aSubject + ", " + aTopic + ", " + aData + ")");
        if (aTopic == "MsgMsgDisplayed") {
            var messenger =  CC["@mozilla.org/messenger;1"].
                createInstance().QueryInterface(CI.nsIMessenger);
            var msgService = messenger.messageServiceFromURI(aData);
            bugmailStreamListener.uri = aData;
            bugmailStreamListener.bypassCache = false;
            try {
                msgService.streamMessage(aData, bugmailStreamListener, null,
                                         null, false, "", null);
            } catch(e) {
            }
        }
    },
    
    forceUpdate: function() {
        var messenger =  CC["@mozilla.org/messenger;1"].
            createInstance().QueryInterface(CI.nsIMessenger);
        var msgService = messenger.messageServiceFromURI(bugmailStreamListener.uri);
        bugmailStreamListener.bypassCache = true;
        try {
            msgService.streamMessage(bugmailStreamListener.uri, bugmailStreamListener, null,
                                     null, false, "", null);
        } catch(e) {
        }
    },
    
    loadHiddenIFrame: function(text) {
        var content = document.getElementById("bugmail-iframe").contentDocument;
        var range = content.createRange();
        var root = content.getElementById("root");
        while (root.lastChild) {
            root.removeChild(root.lastChild);
        }
        range.selectNode(root);
        var frag = range.createContextualFragment(text);
        root.appendChild(frag);
        return content;
    }
};

var bugmailStreamListener = {

    message: "",
    uri: null,
    bypassCache: false,

    QueryInterface: function(aIId, instance) {
        if (aIId.equals(CI.nsIStreamListener) ||
            aIId.equals(CI.nsISupports))
            return this;
        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    onStartRequest: function(request, context) {
    },

    onStopRequest: function(request, context, status, errorMsg) {
        try {
            var headers = this.message.split(/\n\n|\r\n\r\n|\r\r/)[0];
            var mimeHeaders = CC["@mozilla.org/messenger/mimeheaders;1"].
                createInstance(CI.nsIMimeHeaders);
            mimeHeaders.initialize(headers, headers.length);
            this.message = "";
            bugmail.update(this.bypassCache, this.uri, mimeHeaders);
        }
        catch (ex) {
            return;
        }
    },

    onDataAvailable: function(request, context, inputStream, offset, count) {
        try {
            var inStream = CC["@mozilla.org/scriptableinputstream;1"].createInstance(CI.nsIScriptableInputStream);
            inStream.init(inputStream);
            
            // It is necessary to read in data from the input stream
            var inData = inStream.read(count);

            // Also ignore stuff after the first 25K or so
            // should be enough to get headers...
            if (this.message && this.message.length > 25000)
                return 0;

            this.message += inData;
            return 0;
        }
        catch (ex) {
            return 0;
        }
    }
};


function cleanup() {
    //alert("Bugmail cleanup");
    var ObserverService = CC["@mozilla.org/observer-service;1"].
        getService(CI.nsIObserverService);
    ObserverService.removeObserver(bugmail, "MsgMsgDisplayed");
}

window.addEventListener("load", function(e) {
    var ObserverService = CC["@mozilla.org/observer-service;1"].
        getService(CI.nsIObserverService);
    ObserverService.addObserver(bugmail, "MsgMsgDisplayed", false);
    console.log("bugmail: normal messages hook installed");
});

///////////////////////////////////////////////////////////////////////////
// Thunderbird Conversations hooking
///////////////////////////////////////////////////////////////////////////

/*
 Conversations do not provide MsgMsgDisplayed event. Instead, one
 can subscribe their own events. See
    http://blog.xulforum.org/index.php?post/2010/11/27/Thunderbird-Conversations-plugins
 and
    https://github.com/protz/GMail-Conversation-View/blob/master/modules/hook.js

 In particular, onMessageStreamed hook is called whenever some message
 is displayed in conversations view.

 The problem is that while we have both message here, and dom objects,
 the message is database-loaded, not remote, and DOM layout is different.
 Therefore fairly different way to examine whether given element is a bug,
 and what bug is it referencing, is needed.
 */

window.addEventListener("load", function(e) {

    let hasConversations;
    // Trying two locations of conversations hook
    try {
        // Older
        CU.import("resource://conversations/hook.js");
        hasConversations = true;
    } catch (e) {
        // Newer
        try {
            CU.import("resource://conversations/modules/hook.js");
            hasConversations = true;
        } catch(e2) {
            console.log("bugmail: Failed to import Thunderbird conversations hook, most likely this plugin is not installed. Error details for older location: " + e + ", for newer location: " + e2);
            hasConversations = false;
        }
    }

    if (hasConversations) {
        console.log("Thunderbird conversations are active, installing hook for their mode");
        registerHook({
            // Called whenever some message is displayed in conversation view.
            // Arguments:
            //   aMsgHdr: [xpconnect wrapped nsIMsgDBHdr]
            //   aDomNode: [object HTMLLIElement]
            //   aMsgWindow: [xpconnect wrapped nsIMsgWindow]
            //   aMessage:  undefined  (is to appear in newer conversations versions probably)
            //
            // Some interesting attributes:
            //    aMsgWindow.msgHeaderSink [nsIMsgHeaderSink]
            //    aDomNode.baseURI  (wrong, "chrome://conversations/content/stub.xhtml")
            // 
            // if I had a message, then 
            //  aMessage.folder.getUriForMsg(aMessage)
            // or even
            //  aMessage.folder.getUriForMsg(aMsgHdr)
            // would give uri

            onMessageStreamed: function (aMsgHdr, aDomNode, aMsgWindow, aMessage) {
                console.log("bugmail: onMessageStreamed called");
                /*
                  console.log("aMsgHdr: " + aMsgHdr);
                  console.log("Dom node: " + aDomNode);
                  console.log("Msg window: " + aMsgWindow);
                  console.log("aMessage: " + aMessage);
                  console.log("aMsgHdr.folder: " + aMsgHdr.folder);
                  // again stub.xhtml
                  console.log("aDomNode.baseUri = " + aDomNode.baseURI); // or .baseURIObject
                */
                /*
                  var enumerator = aMsgHdr.propertyEnumerator;
                  while(enumerator.hasMore()) {
                  console.log("Property: " + enumerator.getNext());
                  }
                */

                // Proof of concept, to be migrated down once works

                var product = aMsgHdr.getProperty("x-bugzilla-product");
                if(product) {
                    console.log("bugmail: We have bugzilla bug here, trying to locate it's uri");
                    /*
                      var doc = aDomNode.ownerDocument;
                      console.log("doc = " + doc);
                      var uri = doc.querySelector("a[href*=show_bug]").href +
                      "&ctype=xml&excludefield=attachmentdata";
                    */
                    var iframe = aDomNode.getElementsByTagName("iframe")[0];
                    var iframeDoc = iframe.contentDocument;
                    console.log("bugmail: Inner document uri=" + iframeDoc.documentURI);  // YES: here we have imap://....
                    var uri = iframeDoc.querySelector("a[href*=show_bug]").href +
                        "&ctype=xml&excludefield=attachmentdata";
                    console.log("bugmail: uri from doc = " + uri);  // YES: this is OK
                    bugmail.update_using_engine(0, // bypasscache, maybe bugmailStreamListener.bypassCache, 
                                                bugzillaEngine,
                                                uri);
                    console.log("bugmail: display updated");
                }

                
            }
        });
        console.log("bugmail: Conversations hook installed");
    } else {
        console.log("bugmail: Thunderbird Conversations not active, so hook not installed");
    }

});